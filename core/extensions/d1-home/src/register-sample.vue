<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { CREATED_BUT_HIDDEN_MESSAGE, NO_PERSON_MESSAGE, createdRecord, recordRoute } from '@d1/ui';
import { buildGeometry, dimsText, FORMS, FORM_FIELDS, PRESETS, fieldLabel } from './geometry';

const api = useApi();
const router = useRouter();
const { useUserStore } = useStores();
const userStore = useUserStore() as any;
// An admin reads every row, so a sample with no owner is still visible to them: only members need
// a People row to see what they register.
const isAdmin = computed(() => {
	const u = userStore.currentUser;
	return Boolean(userStore.isAdmin ?? u?.admin_access ?? u?.role?.admin_access);
});

interface Opt { text: string; value: string; extra?: string }
const materials = ref<Opt[]>([]);
const methods = ref<Opt[]>([]);
const projects = ref<Opt[]>([]);
const forms = FORMS;
const formLabel = computed(() => forms.find((x) => x.value === f.value.form)?.text ?? f.value.form);

const f = ref<Record<string, any>>({
	material_id: null,
	primary_method_id: null,
	manufactured_date: new Date().toISOString().slice(0, 10),
	form: null,
	diameter_mm: null,
	length_mm: null,
	width_mm: null,
	thickness_mm: null,
	gauge_length_mm: null,
	gauge_width_mm: null,
	mass_grams: null,
	project_id: null,
	location: null,
	nickname: null,
	notes: null,
});

// The sample number is assigned by the database on save (trigger on physical_samples replaces a
// leading {seq}-). `seq` is only a preview of it, read with this user's permissions, so it can be
// lower than the real next number; a failed read shows `seqError` and "?" -- never a made-up 1.
const seq = ref<number | null>(null);
const seqError = ref('');
const saving = ref(false);
const error = ref('');
const created = ref<{ id: string; code: string } | null>(null);
// Set when the sample was created but the answer was empty: the user cannot read it (ADR-0011).
const createdHidden = ref(false);
// The People row of this login: ownership points at it, and without one a registered sample is
// owned by nobody and not readable by its creator. null = no row, undefined = not known (yet).
const personId = ref<string | null | undefined>(undefined);

async function lookupPerson(): Promise<string | null | undefined> {
	const uid = (userStore.currentUser as any)?.id;
	if (!uid) return undefined;
	try {
		const pr = await api.get('/items/people', {
			params: { filter: { user_id: { _eq: uid } }, fields: ['person_id'], limit: 1 },
		});
		return pr?.data?.data?.[0]?.person_id ?? null;
	} catch {
		return undefined; // unknown: let the server decide
	}
}

// Live parametric isometric preview + the dimension inputs relevant to the chosen
// form. Picking a standard test coupon fills its standard dimensions, which then
// stay editable and reshape the drawing.
const dimFields = computed<string[]>(() => FORM_FIELDS[(f.value.form || '').toLowerCase()] ?? []);
const geoSvg = computed(() => buildGeometry(f.value as any));
const geoDimsText = computed(() => dimsText(f.value as any));
const flabel = fieldLabel;

watch(() => f.value.form, (form) => {
	const preset = PRESETS[(form || '').toLowerCase()];
	if (preset) Object.assign(f.value, preset); // standard specimen → standard dimensions
});

function codeWith(num: string): string {
	const mat = materials.value.find((m) => m.value === f.value.material_id);
	const met = methods.value.find((m) => m.value === f.value.primary_method_id);
	if (!mat?.extra || !met?.extra) return '';
	const d = new Date(f.value.manufactured_date || Date.now());
	return `${num}-${mat.extra}-${met.extra}-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
// What is sent: the number is left to the database.
const codeTemplate = computed(() => codeWith('{seq}'));
// What is shown.
const codePreview = computed(() => codeWith(seq.value != null ? String(seq.value) : '?'));

const canSubmit = computed(() => !!f.value.material_id && !!f.value.primary_method_id && !!codeTemplate.value);

// Preview only: /d1-next-number/sample asks the database (the same rule as the save-time trigger).
async function nextSequence(): Promise<number | null> {
	try {
		const res = await api.get('/d1-next-number/sample');
		const n = Number(res?.data?.next);
		if (!Number.isFinite(n)) throw new Error('no number returned');
		seqError.value = '';
		return n;
	} catch {
		seqError.value = 'Could not read the next sample number, so no preview is available. The database still assigns the number when you save.';
		return null;
	}
}

async function submit() {
	if (!canSubmit.value || saving.value) return;
	saving.value = true;
	error.value = '';
	try {
		const payload: Record<string, any> = { sample_code: codeTemplate.value };
		for (const k of ['material_id', 'primary_method_id', 'manufactured_date', 'form', 'project_id', 'location', 'nickname', 'notes']) {
			if (f.value[k] !== null && f.value[k] !== '') payload[k] = f.value[k];
		}
		for (const k of ['diameter_mm', 'length_mm', 'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm', 'mass_grams']) {
			if (f.value[k] !== null && f.value[k] !== '') payload[k] = Number(f.value[k]);
		}
		// Ownership points at people, not directus_users: the owner is the current user's person
		// row. Without one the sample would belong to nobody and its creator could not see it, so
		// refuse up front instead of registering it into the void.
		if (personId.value === undefined) personId.value = await lookupPerson();
		if (personId.value === null && !isAdmin.value) {
			error.value = NO_PERSON_MESSAGE;
			return;
		}
		if (personId.value) payload.owner_person_id = personId.value;

		const res = await api.post('/items/physical_samples', payload);
		// An empty answer (HTTP 204) means created but not readable by this user.
		const row = createdRecord(res.data, 'sample_id', 'sample_code');
		createdHidden.value = !row;
		created.value = row ?? { id: '', code: '' };
	} catch (e: any) {
		error.value = e?.response?.data?.errors?.[0]?.message || e?.message || 'Could not register the sample.';
	} finally {
		saving.value = false;
	}
}

function resetForm() {
	created.value = null;
	createdHidden.value = false;
	f.value.material_id = null;
	f.value.primary_method_id = null;
	f.value.form = null;
	f.value.diameter_mm = f.value.length_mm = f.value.width_mm = f.value.thickness_mm = null;
	f.value.gauge_length_mm = f.value.gauge_width_mm = f.value.mass_grams = null;
	f.value.nickname = f.value.notes = f.value.location = null;
	nextSequence().then((n) => (seq.value = n));
}

const go = (to: string) => router.push(to); // router base is already /admin
const openReport = (id: string) => window.open(`/d1-report/sample/${id}`, '_blank', 'noopener');

onMounted(async () => {
	lookupPerson().then((p) => (personId.value = p));
	const [m, me, p, s] = await Promise.all([
		api.get('/items/materials', { params: { fields: ['material_id', 'common_name', 'alloy_code'], sort: 'common_name', limit: -1 } }),
		api.get('/items/manufacturing_methods', { params: { fields: ['method_id', 'method_name', 'method_code'], sort: 'method_name', limit: -1 } }),
		api.get('/items/projects', { params: { fields: ['project_id', 'project_code', 'project_name'], sort: 'project_code', limit: -1 } }),
		nextSequence(),
	]);
	materials.value = (m.data.data || []).map((x: any) => ({ text: `${x.common_name || '—'}${x.alloy_code ? ` · ${x.alloy_code}` : ''}`, value: x.material_id, extra: x.alloy_code }));
	methods.value = (me.data.data || []).map((x: any) => ({ text: `${x.method_name || '—'}${x.method_code ? ` · ${x.method_code}` : ''}`, value: x.method_id, extra: x.method_code }));
	projects.value = (p.data.data || []).map((x: any) => ({ text: `${x.project_code || ''} — ${x.project_name || ''}`, value: x.project_id }));
	seq.value = s;
});
</script>

<template>
	<private-view title="Register a Sample">
		<div class="wrap">
			<!-- success -->
			<div v-if="created" class="card done">
				<v-icon name="check_circle" class="done-ic" />
				<h2>Sample registered</h2>
				<template v-if="createdHidden">
					<p class="hidden-note">{{ CREATED_BUT_HIDDEN_MESSAGE }}</p>
					<div class="done-actions">
						<v-button secondary @click="resetForm"><v-icon name="add" left />Register another</v-button>
					</div>
				</template>
				<template v-else>
					<p class="code">{{ created.code }}</p>
					<div class="done-actions">
						<v-button @click="go(recordRoute('physical_samples', created.id))"><v-icon name="open_in_new" left />Open record</v-button>
						<v-button secondary @click="openReport(created.id)"><v-icon name="picture_as_pdf" left />PDF</v-button>
						<v-button secondary @click="resetForm"><v-icon name="add" left />Register another</v-button>
					</div>
				</template>
			</div>

			<template v-else>
				<div class="intro">
					<h1>Register a Sample</h1>
					<p>Pick the material and route — the sample code builds itself.</p>
				</div>

				<section class="card">
					<h3><span class="step">1</span> Material &amp; route</h3>
					<div class="row">
						<div class="fld"><label>Material</label><v-select :items="materials" v-model="f.material_id" placeholder="Choose material…" show-deselect /></div>
						<div class="fld"><label>Manufacturing route</label><v-select :items="methods" v-model="f.primary_method_id" placeholder="Choose route…" show-deselect /></div>
					</div>
					<div class="row">
						<div class="fld"><label>Manufactured date</label><input type="date" class="date" v-model="f.manufactured_date" /></div>
						<div class="fld code-preview">
							<label>Sample code</label>
							<div class="code-val"><span v-if="codePreview">{{ codePreview }}</span><span v-else class="muted">Pick material + route</span></div>
							<p v-if="seqError" class="err">{{ seqError }}</p>
							<p v-else-if="codePreview" class="muted">The number is a preview; the database assigns the final one when you register.</p>
						</div>
					</div>
				</section>

				<section class="card">
					<h3><span class="step">2</span> Geometry</h3>
					<div class="row"><div class="fld"><label>Form</label><v-select :items="forms" v-model="f.form" placeholder="Shape…" show-deselect /></div><div class="fld"><label>Mass (g)</label><v-input type="number" v-model="f.mass_grams" placeholder="0" /></div></div>
					<div class="dimgrid" v-if="dimFields.length">
						<div class="fld" v-for="k in dimFields" :key="k">
							<label>{{ flabel(k) }}</label>
							<v-input type="number" :model-value="f[k]" @update:model-value="f[k] = $event" placeholder="0" />
						</div>
					</div>
					<div class="geo-live" v-if="geoSvg">
						<div class="geo-canvas" v-html="geoSvg"></div>
						<div class="geo-cap">{{ formLabel }}<span v-if="geoDimsText"> · {{ geoDimsText }}</span></div>
					</div>
					<div class="geo-live empty" v-else><span>Pick a form to preview the shape</span></div>
				</section>

				<section class="card">
					<h3><span class="step">3</span> Provenance</h3>
					<div class="row"><div class="fld"><label>Project</label><v-select :items="projects" v-model="f.project_id" placeholder="Project…" show-deselect /></div><div class="fld"><label>Nickname</label><v-input v-model="f.nickname" placeholder="Optional friendly name" /></div></div>
					<div class="fld"><label>Location</label><v-input v-model="f.location" placeholder="Where is it stored?" /></div>
				</section>

				<section class="card">
					<h3><span class="step">4</span> Notes</h3>
					<v-textarea v-model="f.notes" placeholder="Anything worth recording…" />
				</section>

				<p v-if="personId === null && !isAdmin && !error" class="err" role="alert">{{ NO_PERSON_MESSAGE }}</p>
				<p v-if="error" class="err">{{ error }}</p>
				<div class="actions">
					<v-button secondary @click="go('/home')">Cancel</v-button>
					<v-button :disabled="!canSubmit" :loading="saving" large @click="submit"><v-icon name="add_circle" left />Register sample</v-button>
				</div>
			</template>
		</div>
	</private-view>
</template>

<script lang="ts">
export default { inheritAttrs: false };
</script>

<style scoped>
.wrap { max-width: 780px; margin: 0 auto; padding: 24px 32px 64px; }
.intro { margin-bottom: 20px; }
.intro h1 { margin: 0; font-size: 24px; font-weight: 750; }
.intro p { margin: 4px 0 0; color: var(--theme--foreground-subdued, #6b7684); }

.geo-live { margin-top: 14px; display: flex; flex-direction: column; align-items: center; gap: 6px;
	padding: 14px; background: var(--theme--background-subdued, #f5f7fa); border-radius: 10px; }
.geo-live.empty span { color: var(--theme--foreground-subdued, #8a94a6); font-style: italic; font-size: 13px; }
.dimgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 620px) { .dimgrid { grid-template-columns: repeat(2, 1fr); } }
.geo-canvas :deep(svg) { width: 260px; max-width: 100%; height: auto; display: block; }
.geo-canvas :deep(.gt) { fill: #dbeafe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.geo-canvas :deep(.gl) { fill: #bfdbfe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.geo-canvas :deep(.gr) { fill: #93c5fd; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.geo-canvas :deep(.gh) { fill: #fff; stroke: #1d4ed8; stroke-width: 1.2; }
.geo-canvas :deep(.gdim) { stroke: #475569; stroke-width: 0.8; }
.geo-canvas :deep(.gext) { stroke: #94a3b8; stroke-width: 0.5; }
.geo-canvas :deep(.gdimt) { fill: #334155; font-size: 8px; font-weight: 700; text-anchor: middle;
	font-family: -apple-system, "Segoe UI", Roboto, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 2.5px; }
.geo-canvas :deep(.gsupport) { fill: #94a3b8; stroke: #475569; stroke-width: 0.6; }
.geo-canvas :deep(.gload) { stroke: #b91c1c; stroke-width: 1.4; }
.geo-cap { font-size: 11px; color: var(--theme--foreground-subdued, #6b7684); text-transform: capitalize; }

.card {
	background: var(--theme--background, #fff);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-radius: 14px; padding: 20px 22px; margin-bottom: 16px;
}
.card h3 { margin: 0 0 16px; font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
.step { width: 22px; height: 22px; border-radius: 50%; background: var(--theme--primary, #1d4ed8); color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 700; }

.row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 14px; }
.row3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.row:last-child, .row3:last-child { margin-bottom: 0; }
.fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.fld label { font-size: 12px; font-weight: 600; color: var(--theme--foreground-subdued, #6b7684); }
.date { height: 44px; border: 2px solid var(--theme--border-color, #dfe3e8); border-radius: 8px; padding: 0 12px; font: inherit; background: var(--theme--background, #fff); color: var(--theme--foreground, #1e293b); }

.code-preview .code-val {
	height: 44px; display: flex; align-items: center; padding: 0 14px; border-radius: 8px;
	background: color-mix(in srgb, var(--theme--primary, #1d4ed8) 8%, transparent);
	border: 1px dashed color-mix(in srgb, var(--theme--primary, #1d4ed8) 40%, transparent);
	font-family: var(--theme--fonts--monospace--font-family, 'SF Mono', Menlo, monospace); font-weight: 700;
	color: var(--theme--primary, #1d4ed8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.muted { color: var(--theme--foreground-subdued, #98a2b3); font-family: inherit; font-weight: 400; }

.actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 8px; }
.err { color: var(--theme--danger, #dc2626); margin: 8px 0; font-size: 13px; }

.done { text-align: center; padding: 48px 24px; }
.done-ic { --v-icon-size: 56px; --v-icon-color: #16a34a; }
.done h2 { margin: 12px 0 4px; font-size: 20px; }
.done .code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; font-size: 18px; color: var(--theme--primary, #1d4ed8); margin: 0 0 24px; }
.done .hidden-note { margin: 0 0 24px; color: var(--theme--warning, #b45309); }
.done-actions { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }

@media (max-width: 720px) { .row, .row3 { grid-template-columns: 1fr; } }
</style>
