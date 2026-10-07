<template>
	<div class="d1-operation-code">
		<v-input
			:model-value="shownValue"
			placeholder="auto-generated from the fields below…"
			@update:model-value="onType"
		>
			<template #append>
				<v-icon
					v-tooltip="manual ? 'Regenerate from fields' : 'Auto-generated'"
					:name="manual ? 'refresh' : 'auto_fix_high'"
					:clickable="manual"
					:class="{ active: !manual }"
					@click="regenerate"
				/>
			</template>
		</v-input>
		<small class="hint">
			{{ manual ? 'Manual override — click ↻ to regenerate.' : 'Auto-generated; type to override.' }}
			<template v-if="hasPlaceholder"> The operation number is a preview; the database assigns the final one on save.</template>
		</small>
		<small v-if="previewError" class="hint error">{{ previewError }}</small>
	</div>
</template>

<script setup lang="ts">
import { inject, ref, computed, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';

const props = defineProps<{ value: string | null; primaryKey?: string | number | null }>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

const values = inject<Ref<Record<string, any>>>('values', ref({}));
const api = useApi();

// Existing records arrive with a value already set — never auto-clobber those.
// `value` can populate a tick after mount, so also key off the primary key: a
// real id (not '+') means an existing record we must never dirty on open.
const isExistingItem = () => props.primaryKey != null && props.primaryKey !== '+';
const manual = ref<boolean>(!!props.value || isExistingItem());

// --- resolve the input sample's code from sample_id ---
// The operation number and the sintering MF number are assigned by the database when the record
// is saved (trigger on manufacturing_operations). The interface composes the readable part of the
// code and leaves {seq} / {mf} placeholders for the database to fill; the estimates below only
// feed the on-screen preview. A failed lookup shows an error and a "?" -- never a made-up number.
const SEQ = '{seq}';
const MF = '{mf}';
const sampleCode = ref<string | null>(null);
const seqEstimate = ref<number | null>(null);
const previewError = ref<string>('');
let lastSampleId: string | null = null;
let sampleReq = 0;
const sampleId = computed<string | null>(() => values.value?.sample_id ?? null);
watch(
	sampleId,
	async (id) => {
		if (id === lastSampleId) return;
		lastSampleId = id;
		const req = ++sampleReq;
		if (!id) {
			sampleCode.value = null;
			seqEstimate.value = null;
			return;
		}
		try {
			const [res, agg] = await Promise.all([
				api.get(`/items/physical_samples/${id}`, { params: { fields: ['sample_code'] } }),
				isExistingItem()
					? Promise.resolve(null)
					: api.get('/items/manufacturing_operations', {
							params: { filter: { sample_id: { _eq: id } }, aggregate: { max: 'operation_sequence' } },
						}),
			]);
			if (req !== sampleReq) return; // a newer sample was picked meanwhile
			sampleCode.value = res?.data?.data?.sample_code ?? null;
			const m = agg ? Number(agg?.data?.data?.[0]?.max?.operation_sequence ?? 0) : null;
			seqEstimate.value = m == null ? null : (Number.isFinite(m) ? m : 0) + 1;
			previewError.value = '';
		} catch {
			if (req !== sampleReq) return;
			sampleCode.value = null;
			seqEstimate.value = null;
			previewError.value = 'Could not read the sample or its operations - the preview number is unavailable.';
		}
	},
	{ immediate: true },
);

// Render a number without trailing-zero noise: 80 → "80", 0.05 → "0.05".
function num(v: unknown): string {
	if (v === null || v === undefined || v === '') return '';
	const n = Number(v);
	if (Number.isNaN(n)) return '';
	return String(parseFloat(n.toPrecision(6)));
}

// DD-MM-YY for the sintering code (FAST ops carry no sample, so the date + a global
// counter are what make the code unique). Empty when no date is set yet.
function dateCode(v: unknown): string {
	if (!v) return '';
	const d = new Date(v as string);
	if (Number.isNaN(d.getTime())) return '';
	const p = (x: number) => String(x).padStart(2, '0');
	return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
}

// Preview of the global sintering counter for a NEW sintering op: the next MF number after the
// highest one in any sintering code. Preview only -- the database assigns the real {mf} number
// (max+1 under a lock), so a reused or racing number can no longer be stored.
const mfEstimate = ref<number | null>(null);
watch(
	() => values.value?.process_category,
	async (cat) => {
		if (cat !== 'sintering' || isExistingItem() || mfEstimate.value != null) return;
		try {
			const res = await api.get('/items/manufacturing_operations', {
				params: { filter: { process_category: { _eq: 'sintering' } }, fields: ['pass_code'], limit: -1 },
			});
			let max = 0;
			for (const r of res?.data?.data ?? []) {
				const m = /(?:^|-)MF(\d{1,9})(?:-|$)/.exec(r.pass_code ?? '');
				if (m) max = Math.max(max, parseInt(m[1], 10));
			}
			mfEstimate.value = max + 1;
		} catch {
			mfEstimate.value = null;
			previewError.value = 'Could not read the existing sintering codes - the MF number preview is unavailable.';
		}
	},
	{ immediate: true },
);

// Abbreviation maps for the typed dropdowns.
const HT_TYPE: Record<string, string> = {
	anneal: 'A', solution_treat: 'S', age: 'AG', quench: 'Q',
	temper: 'T', stress_relieve: 'SR', normalise: 'N', other: 'X',
};
const HT_COOL: Record<string, string> = {
	furnace: 'FC', air: 'AC', water_quench: 'WQ', oil_quench: 'OQ', forced_air: 'FA', other: 'X',
};
const DEFORM_TOKEN: Record<string, string> = {
	rolling: 'DR', forging: 'DF', extrusion: 'DE', drawing: 'DD', other: 'DX',
};

// Compose the parameter-keyed code per process category:
//   base = {sample}-{op token};  then -{param}_{param}…  (only the variables that are set)
const autoCode = computed<string>(() => {
	const v = values.value ?? {};
	const sample = sampleCode.value ?? '';
	const cat = (v.process_category ?? '') as string;

	// Per-sample sequence number — the unique identifier every operation carries, so
	// two ops on the same sample never collide even with identical parameters. For
	// machining this is the facing/roughing pass number; for other methods it's just
	// the Nth operation on the sample.
	// A number the user typed (a machining pass number) or a saved record's own number is used as is;
	// for a new record with a sample the database assigns it, so the code carries a placeholder.
	const seq = v.operation_sequence;
	const typedSeq = seq === '' || seq === null || seq === undefined ? '' : String(seq);
	const seqStr = typedSeq || (!isExistingItem() && sampleCode.value ? SEQ : '');

	let token = '';
	let parts: string[] = [];

	if (cat === 'machining') {
		token = `${v.machining_operation_subtype ?? ''}${seqStr}`;
		parts = [
			num(v.machining_cutting_speed_m_per_min) && `${num(v.machining_cutting_speed_m_per_min)}MPM`,
			num(v.machining_feed_mm_per_rev) && `${num(v.machining_feed_mm_per_rev)}feed`,
			num(v.machining_axial_depth_of_cut_mm) && `${num(v.machining_axial_depth_of_cut_mm)}DoC`,
		].filter(Boolean) as string[];
	} else if (cat === 'sintering') {
		// FAST/sintering ops usually have no sample link, so uniqueness comes from the
		// date + a global counter:  DD-MM-YY-MF{NNNN}-{params}  (matches the backfill).
		const dcode = dateCode(v.operation_date);
		// A saved record keeps its MF number; a new one gets the database's next one.
		const keptMf = isExistingItem() ? /(?:^|-)MF(\d{1,9})(?:-|$)/.exec(props.value ?? '')?.[1] : undefined;
		const mf = `MF${keptMf ?? MF}`;
		const sparams = [
			num(v.sintering_max_temp_celsius) && `${num(v.sintering_max_temp_celsius)}C`,
			num(v.sintering_max_force_kn) && `${num(v.sintering_max_force_kn)}kN`,
			num(v.sintering_mould_diameter_mm) && `${num(v.sintering_mould_diameter_mm)}dia`,
		].filter(Boolean).join('_');
		return [dcode, mf, sparams].filter(Boolean).join('-');
	} else if (cat === 'heat_treatment') {
		token = `HT${HT_TYPE[v.ht_treatment_type] ?? ''}${seqStr}`;
		parts = [
			num(v.ht_peak_temp_celsius) && `${num(v.ht_peak_temp_celsius)}C`,
			num(v.ht_hold_time_min) && `${num(v.ht_hold_time_min)}min`,
			HT_COOL[v.ht_cooling_method],
		].filter(Boolean) as string[];
	} else if (cat === 'deformation') {
		token = `${DEFORM_TOKEN[v.deform_deformation_type] ?? 'D'}${seqStr}`;
		parts = [
			num(v.deform_deformation_temp_celsius) && `${num(v.deform_deformation_temp_celsius)}C`,
			num(v.deform_total_reduction_pct) && `${num(v.deform_total_reduction_pct)}pct`,
			num(v.deform_pass_count) && `${num(v.deform_pass_count)}p`,
		].filter(Boolean) as string[];
	} else if (cat === 'additive') {
		token = `${v.am_process_variant ?? 'AM'}${seqStr}`;
		parts = [
			num(v.am_laser_power_w) && `${num(v.am_laser_power_w)}W`,
			num(v.am_scan_speed_mm_per_s) && `${num(v.am_scan_speed_mm_per_s)}mmps`,
			num(v.am_layer_thickness_mm) && `${num(v.am_layer_thickness_mm)}mm`,
		].filter(Boolean) as string[];
	} else {
		return sample && seqStr ? `${sample}-${seqStr}` : sample; // unknown category — sample + seq
	}

	let code = sample;
	if (token) code = code ? `${code}-${token}` : token;
	if (code && parts.length) code = `${code}-${parts.join('_')}`;
	return code;
});

// What the user sees: placeholders replaced by the preview numbers ("?" when unavailable).
function preview(code: string | null | undefined): string {
	if (!code) return code ?? '';
	return code
		.split(SEQ).join(seqEstimate.value != null ? String(seqEstimate.value) : '?')
		.split(MF).join(mfEstimate.value != null ? String(mfEstimate.value) : '?');
}
const hasPlaceholder = computed(() => !manual.value && /\{(seq|mf)\}/.test(props.value ?? autoCode.value ?? ''));
const shownValue = computed(() => preview(props.value));

// While in auto mode, keep the field in sync with the composed code.
watch(
	autoCode,
	(code) => {
		if (isExistingItem()) return;   // never auto-emit for saved records
		if (!manual.value && code && code !== props.value) emit('input', code);
	},
	{ immediate: true },
);

function onType(val: string | null) {
	// Typing the preview back (or clearing the box) returns to auto mode, which keeps the
	// placeholders so the database still assigns the numbers; anything else is a manual override.
	if (!val || val === preview(autoCode.value)) {
		manual.value = false;
		emit('input', val ? autoCode.value : val);
		return;
	}
	manual.value = true;
	emit('input', val);
}

function regenerate() {
	manual.value = false;
	if (autoCode.value) emit('input', autoCode.value);
}
</script>

<style scoped>
.d1-operation-code { width: 100%; }
.hint {
	display: block;
	margin-top: 4px;
	font-size: 12px;
	color: var(--theme--foreground-subdued, #999);
	font-style: italic;
}
.hint.error { color: var(--theme--danger, #c62828); font-style: normal; }
.v-icon.active { color: var(--theme--primary, #1565c0); }
</style>
