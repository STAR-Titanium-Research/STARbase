<script setup lang="ts">
// Correct a capture's metadata after the fact — the motivating case is a forgotten Sample locking
// Upload out at cut end with no way back in, but any field can be wrong and only noticed later.
// Two write paths, chosen by whether this capture already has a Directus row:
//   - not uploaded: PATCH /captures/{id}/metadata rewrites summary.json only.
//   - uploaded: the SAME local patch, plus a direct Directus PATCH on the existing
//     manufacturing_operations row (this app already talks to Directus straight from the browser
//     for reads — see CapturesSettings.vue's checkUploaded() — so no new backend endpoint is
//     needed for that half).
// Field set and key names mirror workspace.ts's live RecordingOptions.vue / metaObj() deliberately:
// a capture recorded before or after this editor exists reads and writes through the same shape.
import { reactive, ref, onMounted } from 'vue';
import { getConfig } from '../config';
import { api } from '../directusClient';
import {
	searchSamples, searchOperators, searchEquipment, searchTools, searchInserts, searchEdges,
	resolveMachiningMethodId, type LookupItem,
} from '../record/directusLookups';
import LookupField from '../record/panels/LookupField.vue';
import { confirmAction } from '../ui/confirm';
import { useDialog } from '../ui/useDialog';
import { preservedRecorderKeys } from '../recorder';

const props = defineProps<{
	captureId: string;
	/** Present only if this capture already has a manufacturing_operations row. */
	operationId?: string | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const base = () => getConfig().recorderUrl;
const loading = ref(true);
const saving = ref(false);
const errMsg = ref('');

// Mirrors workspace.ts's `link`/`meta`/`machining` shape closely enough that the same key names
// round-trip through extra_metadata whether this capture was last written by a live recording or
// by this dialog.
const link = reactive({
	sampleId: '', sampleLabel: '', operatorId: '', operatorLabel: '',
	equipmentId: '', equipmentLabel: '', insertId: '', insertLabel: '',
	edgeId: '', edgeLabel: '', toolId: '', toolLabel: '',
});
const meta = reactive({ sampleName: '', sampleCode: '', opType: '', coolant: '', notes: '' });
const rec = reactive({ rpm: 0, feed: 0, diam: 0, sampleRate: 0 });
const machining = reactive({
	axialDoc: '', radialDoc: '', cuttingLength: '', coolantPressure: '', operationSequence: '',
	chipsRef: '', newEdge: false, chipsCollected: false,
});

// Mirrors RecordingOptions.vue's own list. Not shared from there — extracting it isn't worth a
// cross-cutting refactor for one dialog's sake, but if the list ever changes, change both.
const MACHINING_SUBTYPES = [
	{ value: 'MT-F', text: 'Turning – Facing' }, { value: 'MT-R', text: 'Turning – Roughing' },
	{ value: 'MT-O', text: 'Turning – OD' }, { value: 'MT-G', text: 'Turning – Grooving' },
	{ value: 'MT-B', text: 'Turning – Boring' }, { value: 'MT-H', text: 'Turning – Threading' },
	{ value: 'MT-P', text: 'Turning – Parting' }, { value: 'MT-D', text: 'Turning – Drilling' },
	{ value: 'MM-F', text: 'Milling – Facing' }, { value: 'MM-R', text: 'Milling – Roughing' },
	{ value: 'MM-S', text: 'Milling – Slotting' }, { value: 'MM-D', text: 'Milling – Drilling' },
	{ value: 'other', text: 'Other' },
] as const;

// Who recorded this cut (recorded_by_*, recorded_at, ...). Not editable here, but this dialog
// rewrites extra_metadata / recorded_metadata wholesale, so it must be carried through or a typo
// fix would erase the recorder -- and with it the owner a later upload assigns.
let recorderKeys: Record<string, any> = {};
// Database-only provenance on an uploaded row (who synced it, when); same reason to keep it.
let syncedKeys: Record<string, any> = {};

function searchEdgesForInsert(q: string) { return searchEdges(q, link.insertId || undefined); }

async function loadFromLocal() {
	const res = await fetch(`${base()}/captures/${props.captureId}/summary`);
	if (!res.ok) throw new Error(`could not load this capture's metadata (HTTP ${res.status})`);
	const s = await res.json();
	const cfg = s.config || {};
	const extra = cfg.extra_metadata || s.metadata || {};
	recorderKeys = preservedRecorderKeys(extra);
	applyExtra(extra);
	meta.sampleName = s.sample_name || extra.sample_name || '';
	rec.rpm = Number(cfg.rpm) || 0; rec.feed = Number(cfg.feed) || 0;
	rec.diam = Number(cfg.diam) || 0; rec.sampleRate = Number(cfg.sample_rate) || 0;
}

function applyExtra(extra: Record<string, any>) {
	link.sampleId = extra.link_sample_id || ''; link.sampleLabel = extra.link_sample_label || '';
	link.operatorId = extra.link_operator_id || ''; link.operatorLabel = extra.link_operator_label || '';
	link.equipmentId = extra.link_equipment_id || ''; link.equipmentLabel = extra.link_equipment_label || '';
	link.insertId = extra.link_insert_id || ''; link.insertLabel = extra.link_insert_label || '';
	link.edgeId = extra.link_edge_id || ''; link.edgeLabel = extra.link_edge_label || '';
	link.toolId = extra.link_tool_id || ''; link.toolLabel = extra.link_tool_label || '';
	meta.sampleCode = extra.sample_code || ''; meta.opType = extra.op_type || '';
	meta.coolant = extra.coolant || ''; meta.notes = extra.notes || '';
	machining.axialDoc = String(extra.axial_doc ?? ''); machining.radialDoc = String(extra.radial_doc ?? '');
	machining.cuttingLength = String(extra.cutting_length ?? ''); machining.coolantPressure = String(extra.coolant_pressure ?? '');
	machining.operationSequence = String(extra.operation_sequence ?? ''); machining.chipsRef = extra.chips_ref || '';
	machining.newEdge = !!extra.new_edge; machining.chipsCollected = !!extra.chips_collected;
}

// A capture recorded before link_* persistence existed (or one that was uploaded and had its
// lookups resolved straight into Directus, never mirrored back locally) has no resolved IDs to
// read from summary.json — only whatever Directus itself currently holds. Reading the live row is
// the accurate source in that case, and it's also simply the right thing to edit: change what's
// actually there, not a stale local echo of what it might once have been.
async function loadFromDirectus(opId: string) {
	const res = await api.get(`/items/manufacturing_operations/${opId}`, {
		params: {
			fields: [
				'sample_id.sample_id', 'sample_id.sample_code', 'sample_id.nickname',
				'operator_person_id.person_id', 'operator_person_id.full_name',
				'equipment_id.equipment_id', 'equipment_id.equipment_name', 'equipment_id.equipment_code',
				'insert_edge_id.edge_id', 'insert_edge_id.edge_code',
				'tool_id.tool_id', 'tool_id.tool_name', 'tool_id.tool_code',
				'machining_operation_subtype', 'machining_spindle_speed_rpm', 'machining_feed_mm_per_rev',
				'machining_workpiece_diameter_mm', 'capture_frequency_khz', 'outcome_notes',
				'machining_axial_depth_of_cut_mm', 'machining_radial_depth_of_cut_mm', 'machining_cutting_length_mm',
				'machining_coolant_pressure_bar', 'operation_sequence', 'machining_new_edge',
				'machining_chips_collected', 'machining_chips_ref_code', 'recorded_metadata',
			],
		},
	});
	const d = res.data?.data || {};
	recorderKeys = preservedRecorderKeys(d.recorded_metadata);
	syncedKeys = Object.fromEntries(Object.entries(d.recorded_metadata ?? {}).filter(([k]) => k.startsWith('synced_')));
	link.sampleId = d.sample_id?.sample_id || ''; link.sampleLabel = d.sample_id?.sample_code || d.sample_id?.nickname || '';
	link.operatorId = d.operator_person_id?.person_id || '';
	link.operatorLabel = d.operator_person_id?.full_name || '';
	link.equipmentId = d.equipment_id?.equipment_id || ''; link.equipmentLabel = d.equipment_id?.equipment_name || d.equipment_id?.equipment_code || '';
	link.edgeId = d.insert_edge_id?.edge_id || ''; link.edgeLabel = d.insert_edge_id?.edge_code || '';
	link.toolId = d.tool_id?.tool_id || ''; link.toolLabel = d.tool_id?.tool_name || d.tool_id?.tool_code || '';
	meta.sampleName = d.recorded_metadata?.sample_name || link.sampleLabel || '';
	meta.opType = d.machining_operation_subtype || '';
	meta.coolant = d.recorded_metadata?.coolant || '';
	meta.notes = d.outcome_notes || '';
	rec.rpm = Number(d.machining_spindle_speed_rpm) || 0; rec.feed = Number(d.machining_feed_mm_per_rev) || 0;
	rec.diam = Number(d.machining_workpiece_diameter_mm) || 0;
	rec.sampleRate = d.capture_frequency_khz ? Number(d.capture_frequency_khz) * 1000 : 0;
	machining.axialDoc = String(d.machining_axial_depth_of_cut_mm ?? ''); machining.radialDoc = String(d.machining_radial_depth_of_cut_mm ?? '');
	machining.cuttingLength = String(d.machining_cutting_length_mm ?? ''); machining.coolantPressure = String(d.machining_coolant_pressure_bar ?? '');
	machining.operationSequence = String(d.operation_sequence ?? ''); machining.chipsRef = d.machining_chips_ref_code || '';
	machining.newEdge = !!d.machining_new_edge; machining.chipsCollected = !!d.machining_chips_collected;
}

onMounted(async () => {
	try {
		if (props.operationId) await loadFromDirectus(props.operationId);
		else await loadFromLocal();
	} catch (e: any) {
		errMsg.value = e?.message || 'failed to load current metadata';
	} finally {
		loading.value = false;
	}
});

function buildExtraMetadata(): Record<string, any> {
	const o: Record<string, any> = { ...recorderKeys };
	if (meta.sampleName) o.sample_name = meta.sampleName;
	if (meta.sampleCode) o.sample_code = meta.sampleCode;
	if (meta.opType) o.op_type = meta.opType;
	if (meta.coolant) o.coolant = meta.coolant;
	if (meta.notes) o.notes = meta.notes;
	const links: [string, string][] = [
		['link_sample_id', link.sampleId], ['link_sample_label', link.sampleLabel],
		['link_operator_id', link.operatorId], ['link_operator_label', link.operatorLabel],
		['link_equipment_id', link.equipmentId], ['link_equipment_label', link.equipmentLabel],
		['link_insert_id', link.insertId], ['link_insert_label', link.insertLabel],
		['link_edge_id', link.edgeId], ['link_edge_label', link.edgeLabel],
		['link_tool_id', link.toolId], ['link_tool_label', link.toolLabel],
	];
	for (const [k, v] of links) if (v) o[k] = v;
	if (machining.axialDoc) o.axial_doc = machining.axialDoc;
	if (machining.radialDoc) o.radial_doc = machining.radialDoc;
	if (machining.cuttingLength) o.cutting_length = machining.cuttingLength;
	if (machining.coolantPressure) o.coolant_pressure = machining.coolantPressure;
	if (machining.operationSequence) o.operation_sequence = machining.operationSequence;
	if (machining.chipsRef) o.chips_ref = machining.chipsRef;
	o.new_edge = machining.newEdge;
	o.chips_collected = machining.chipsCollected;
	return o;
}

function numOrNull(s: string): number | null {
	return s !== '' && Number.isFinite(Number(s)) ? Number(s) : null;
}

async function save() {
	saving.value = true;
	errMsg.value = '';
	try {
		const extra = buildExtraMetadata();
		const localPatch = {
			sample_name: meta.sampleName || undefined,
			rpm: rec.rpm || undefined,
			feed: rec.feed || undefined,
			diam: rec.diam || undefined,
			sample_rate: rec.sampleRate || undefined,
			extra_metadata: extra,
		};
		const localRes = await fetch(`${base()}/captures/${props.captureId}/metadata`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(localPatch),
		});
		if (!localRes.ok) {
			const body = await localRes.json().catch(() => ({}));
			throw new Error(body.detail || `saving locally failed (HTTP ${localRes.status})`);
		}

		if (props.operationId) {
			const surface = Math.PI * (rec.diam || 0) * (rec.rpm || 0) / 1000;
			await api.patch(`/items/manufacturing_operations/${props.operationId}`, {
				sample_id: link.sampleId || null,
				operator_person_id: link.operatorId || null,
				equipment_id: link.equipmentId || null,
				insert_edge_id: link.edgeId || null,
				tool_id: link.toolId || null,
				machining_operation_subtype: meta.opType || null,
				machining_spindle_speed_rpm: rec.rpm || null,
				machining_feed_mm_per_rev: rec.feed || null,
				machining_workpiece_diameter_mm: rec.diam || null,
				machining_cutting_speed_m_per_min: Number.isFinite(surface) ? Number(surface.toFixed(2)) : null,
				machining_coolant_used: !!(meta.coolant && meta.coolant.trim()),
				capture_frequency_khz: rec.sampleRate ? Number((rec.sampleRate / 1000).toFixed(3)) : null,
				outcome_notes: meta.notes || null,
				machining_axial_depth_of_cut_mm: numOrNull(machining.axialDoc),
				machining_radial_depth_of_cut_mm: numOrNull(machining.radialDoc),
				machining_cutting_length_mm: numOrNull(machining.cuttingLength),
				machining_coolant_pressure_bar: numOrNull(machining.coolantPressure),
				operation_sequence: numOrNull(machining.operationSequence),
				machining_new_edge: machining.newEdge,
				machining_chips_collected: machining.chipsCollected,
				machining_chips_ref_code: machining.chipsRef || null,
				method_id: await resolveMachiningMethodId(meta.opType).catch(() => null),
				recorded_metadata: { ...extra, ...syncedKeys, capture_id: props.captureId },
			});
		}
		emit('saved');
	} catch (e: any) {
		errMsg.value = e?.message || 'save failed';
	} finally {
		saving.value = false;
	}
}

async function close() {
	if (!saving.value) emit('close');
}
const panel = ref<HTMLElement | null>(null);
useDialog(panel, close);
async function confirmClose() {
	const ok = await confirmAction({
		title: 'Discard these changes?',
		message: 'Nothing entered here has been saved.',
		confirmLabel: 'Discard',
		tone: 'warning',
	});
	if (ok) close();
}
</script>

<template>
	<div class="ecm-backdrop dialog-backdrop-in" @click.self="close">
		<div ref="panel" class="ecm-modal dialog-in" role="dialog" aria-modal="true" aria-labelledby="ecm-title" tabindex="-1">
			<header class="ecm-head">
				<b id="ecm-title">Edit capture metadata</b>
				<span class="ecm-sub">{{ captureId }}</span>
				<span v-if="operationId" class="ecm-tag uploaded">Uploaded — also updates the database</span>
				<span v-else class="ecm-tag">Not uploaded — local only</span>
			</header>

			<div v-if="loading" class="ecm-loading">
				<span class="material-symbols-rounded spin">progress_activity</span> Loading current metadata…
			</div>

			<template v-else>
				<div class="ecm-body">
					<label class="field">Sample name
						<input v-model="meta.sampleName" :disabled="saving" placeholder="e.g. S-42" />
					</label>
					<LookupField v-model="link.sampleId" :display-label="link.sampleLabel" label="Sample (Directus link)"
						placeholder="search sample code…" :search="searchSamples" :disabled="saving"
						@select="(i: LookupItem) => { link.sampleLabel = i.label; meta.sampleName = i.label; }" />

					<div class="section-divider"><span>Recording parameters</span></div>
					<div class="grid4">
						<label class="field">Spindle (RPM)<input type="number" v-model.number="rec.rpm" :disabled="saving" /></label>
						<label class="field">Feed (mm/rev)<input type="number" step="0.01" v-model.number="rec.feed" :disabled="saving" /></label>
						<label class="field">Diameter (mm)<input type="number" v-model.number="rec.diam" :disabled="saving" /></label>
						<label class="field">Sample rate (Hz)<input type="number" v-model.number="rec.sampleRate" :disabled="saving" /></label>
					</div>

					<div class="section-divider"><span>Details</span></div>
					<label class="field">Operation type
						<select v-model="meta.opType" :disabled="saving">
							<option value="">—</option>
							<option v-for="t in MACHINING_SUBTYPES" :key="t.value" :value="t.value">{{ t.text }}</option>
						</select>
					</label>
					<div class="pair">
						<LookupField v-model="link.equipmentId" :display-label="link.equipmentLabel" label="Machine" placeholder="search machine…"
							:search="searchEquipment" :disabled="saving" @select="(i: LookupItem) => (link.equipmentLabel = i.label)" />
						<LookupField v-model="link.operatorId" :display-label="link.operatorLabel" label="Operator" placeholder="search operator…"
							:search="searchOperators" :disabled="saving" @select="(i: LookupItem) => (link.operatorLabel = i.label)" />
					</div>
					<div class="pair">
						<LookupField v-model="link.insertId" :display-label="link.insertLabel" label="Insert" placeholder="search insert code…"
							:search="searchInserts" :disabled="saving" @select="(i: LookupItem) => { link.insertLabel = i.label; link.edgeId = ''; link.edgeLabel = ''; }" />
						<LookupField v-model="link.edgeId" :display-label="link.edgeLabel" label="Edge" placeholder="search edge code…"
							:search="searchEdgesForInsert" :disabled="saving"
							@select="(i: LookupItem) => { link.edgeLabel = i.label; if (i.extra?.insertId) { link.insertId = i.extra.insertId; link.insertLabel = i.extra.insertLabel; } }" />
					</div>
					<LookupField v-model="link.toolId" :display-label="link.toolLabel" label="Tool" placeholder="search tool name…"
						:search="searchTools" :disabled="saving" @select="(i: LookupItem) => (link.toolLabel = i.label)" />

					<div class="grid2">
						<label class="field">Coolant<input v-model="meta.coolant" :disabled="saving" /></label>
						<label class="field">Coolant pressure (bar)<input type="number" step="0.1" v-model="machining.coolantPressure" :disabled="saving" /></label>
						<label class="field">Axial DoC (mm)<input type="number" step="0.01" v-model="machining.axialDoc" :disabled="saving" /></label>
						<label class="field">Radial DoC (mm)<input type="number" step="0.01" v-model="machining.radialDoc" :disabled="saving" /></label>
						<label class="field">Cutting length (mm)<input type="number" v-model="machining.cuttingLength" :disabled="saving" /></label>
						<label class="field">Chips ref code<input v-model="machining.chipsRef" :disabled="saving" /></label>
					</div>
					<div class="chks">
						<label class="chk"><input type="checkbox" v-model="machining.newEdge" :disabled="saving" /> New edge</label>
						<label class="chk"><input type="checkbox" v-model="machining.chipsCollected" :disabled="saving" /> Chips collected</label>
					</div>
					<label class="field wide">Notes<textarea v-model="meta.notes" rows="2" :disabled="saving"></textarea></label>
				</div>

				<p v-if="errMsg" class="ecm-err">{{ errMsg }}</p>

				<div class="ecm-actions">
					<button class="btn" :disabled="saving" @click="confirmClose">Cancel</button>
					<div class="ecm-spacer"></div>
					<button class="btn primary" :disabled="saving" @click="save">
						{{ saving ? 'Saving…' : operationId ? 'Save (local + database)' : 'Save' }}
					</button>
				</div>
			</template>
		</div>
	</div>
</template>

<style scoped>
.ecm-backdrop { position: fixed; inset: 0; z-index: 250; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); padding: 24px; }
.ecm-modal { width: min(720px, 100%); max-height: 90vh; overflow: auto; display: flex; flex-direction: column; gap: 14px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 30px 80px rgba(0,0,0,0.45); }
.ecm-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; }
.ecm-head b { font-size: var(--fs-lg); color: var(--text); }
.ecm-sub { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-dim); }
.ecm-tag { margin-left: auto; padding: 3px 9px; font-size: var(--fs-xs); font-weight: 600; border-radius: 999px; background: var(--surface); color: var(--text-dim); }
.ecm-tag.uploaded { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.ecm-loading { display: flex; align-items: center; gap: 8px; padding: 30px 0; justify-content: center; color: var(--text-dim); font-size: var(--fs-md); }
.ecm-body { display: flex; flex-direction: column; gap: 4px; }
.field { display: block; font-size: var(--fs-sm); color: var(--text-dim); margin-bottom: 8px; }
.field.wide { display: block; }
.field input:not([type="checkbox"]), .field select, .field textarea { display: block; width: 100%; margin-top: 3px; padding: 7px 9px; font-size: var(--fs-md); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; outline: none; font-family: inherit; box-sizing: border-box; }
.field textarea { font-family: var(--mono); font-size: var(--fs-sm); resize: vertical; }
.field input:focus, .field select:focus, .field textarea:focus { border-color: var(--accent); }
.field input:disabled, .field select:disabled, .field textarea:disabled { opacity: 0.55; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0 10px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.section-divider { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
.section-divider::before, .section-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.chks { display: flex; gap: 16px; margin: 2px 0 8px; }
.chk { display: flex; align-items: center; gap: 6px; font-size: var(--fs-md); color: var(--text); cursor: pointer; }
.chk input { accent-color: var(--accent); }
.ecm-err { font-size: var(--fs-sm); color: var(--danger); background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; padding: 8px 10px; margin: 0; }
.ecm-actions { display: flex; align-items: center; gap: 10px; }
.ecm-spacer { flex: 1; }
</style>
