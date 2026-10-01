<script setup lang="ts">
// Tool-wear trend: peak force across successive passes, for one insert edge (or one sample).
// Wear shows up as peak force climbing pass over pass, which is invisible when the dashboard can
// only display one operation at a time. Everything needed is already recorded on
// manufacturing_operations / machining_force_analysis, so this is a query plus a plot — no schema
// change and no heavy data (peaks are scalar columns, not the series payload).
import { computed, ref, watch } from 'vue';
import { useForceHost } from './host';

const props = defineProps<{
	/** The currently-selected analysis row; the trend is drawn for the edge/sample it belongs to. */
	detail: any | null;
}>();

const AXES = ['Fx', 'Fy', 'Fz'] as const;
type Axis = typeof AXES[number];
const AXIS_COLOR: Record<Axis, string> = { Fx: '#dc2626', Fy: '#16a34a', Fz: '#2563eb' };

const host = useForceHost();
const api = host.api;

interface Point {
	id: string;
	label: string;
	x: number;
	peaks: Record<Axis, number | null>;
	isCurrent: boolean;
}

const rows = ref<any[]>([]);
const loading = ref(false);
const error = ref('');
const visAxes = ref<Record<Axis, boolean>>({ Fx: false, Fy: false, Fz: true });
// Cutting length is the physically meaningful wear axis, but it is optional metadata; sequence
// always exists, so it is the safe default and the automatic fallback.
const xMode = ref<'sequence' | 'length'>('sequence');
// Which set of operations counts as "this tool's life". An edge is the precise unit of wear; a
// sample is the useful fallback when edges aren't recorded.
const groupBy = ref<'edge' | 'sample'>('edge');

const edgeId = computed(() => props.detail?.operation_id?.insert_edge_id?.edge_id
	?? props.detail?.operation_id?.insert_edge_id ?? null);
const sampleId = computed(() => props.detail?.operation_id?.sample_id?.sample_id ?? null);
const groupAvailable = computed(() => (groupBy.value === 'edge' ? !!edgeId.value : !!sampleId.value));

async function load() {
	const d = props.detail;
	if (!d) { rows.value = []; return; }
	const filter: any = { status: { _eq: 'done' } };
	if (groupBy.value === 'edge') {
		if (!edgeId.value) { rows.value = []; return; }
		filter.operation_id = { insert_edge_id: { _eq: edgeId.value } };
	} else {
		if (!sampleId.value) { rows.value = []; return; }
		filter.operation_id = { sample_id: { _eq: sampleId.value } };
	}
	loading.value = true;
	error.value = '';
	try {
		const res = await api.get('/items/machining_force_analysis', {
			params: {
				filter, limit: 200,
				fields: [
					'id', 'peak_fx', 'peak_fy', 'peak_fz',
					'operation_id.operation_id', 'operation_id.pass_code', 'operation_id.operation_date',
					'operation_id.operation_sequence', 'operation_id.machining_cutting_length_mm',
				],
			},
		});
		rows.value = res.data?.data ?? [];
	} catch (e: any) {
		error.value = e?.message || 'could not load the trend';
		rows.value = [];
	} finally { loading.value = false; }
}
watch(() => [props.detail?.id, groupBy.value], load, { immediate: true });

// Cumulative cutting length only means anything if the operations actually carry it.
const lengthAvailable = computed(() =>
	rows.value.some((r) => Number(r.operation_id?.machining_cutting_length_mm) > 0));
watch(lengthAvailable, (ok) => { if (!ok) xMode.value = 'sequence'; });

const points = computed<Point[]>(() => {
	const ordered = [...rows.value].sort((a, b) => {
		const sa = Number(a.operation_id?.operation_sequence ?? Infinity);
		const sb = Number(b.operation_id?.operation_sequence ?? Infinity);
		if (sa !== sb) return sa - sb;
		return String(a.operation_id?.operation_date || '').localeCompare(String(b.operation_id?.operation_date || ''));
	});
	let cum = 0;
	return ordered.map((r, i) => {
		const len = Number(r.operation_id?.machining_cutting_length_mm) || 0;
		cum += len;
		const seq = Number(r.operation_id?.operation_sequence);
		return {
			id: r.id,
			label: r.operation_id?.pass_code || `#${i + 1}`,
			// Cumulative length is what wears an edge; a per-pass value would just be noise.
			x: xMode.value === 'length' ? cum : (Number.isFinite(seq) ? seq : i + 1),
			peaks: {
				Fx: r.peak_fx == null ? null : Number(r.peak_fx),
				Fy: r.peak_fy == null ? null : Number(r.peak_fy),
				Fz: r.peak_fz == null ? null : Number(r.peak_fz),
			},
			isCurrent: r.id === props.detail?.id,
		};
	});
});

const W = 520, H = 210, ML = 46, MR = 12, MT = 12, MB = 30;
const geom = computed(() => {
	const pts = points.value;
	const shown = AXES.filter((a) => visAxes.value[a]);
	if (pts.length < 2 || !shown.length) return null;
	const xs = pts.map((p) => p.x);
	let x0 = Math.min(...xs), x1 = Math.max(...xs);
	if (x1 === x0) x1 = x0 + 1;
	let lo = Infinity, hi = -Infinity;
	for (const p of pts) for (const a of shown) {
		const v = p.peaks[a];
		if (v == null || !Number.isFinite(v)) continue;
		if (v < lo) lo = v; if (v > hi) hi = v;
	}
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
	if (hi === lo) { hi = lo + 1; }
	// Peak force is a magnitude — anchoring at 0 keeps the growth visually honest rather than
	// exaggerating a small drift by cropping the axis to it.
	lo = Math.min(0, lo);
	const pad = (hi - lo) * 0.1;
	hi += pad;
	const sx = (x: number) => ML + ((x - x0) / (x1 - x0)) * (W - ML - MR);
	const sy = (y: number) => MT + (1 - (y - lo) / (hi - lo)) * (H - MT - MB);
	const series = shown.map((a) => ({
		axis: a, color: AXIS_COLOR[a],
		d: pts.reduce((acc, p) => {
			const v = p.peaks[a];
			if (v == null || !Number.isFinite(v)) return acc;
			return acc + `${acc ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(v).toFixed(1)} `;
		}, ''),
		dots: pts.filter((p) => p.peaks[a] != null)
			.map((p) => ({ cx: sx(p.x), cy: sy(p.peaks[a] as number), current: p.isCurrent, label: p.label,
				v: p.peaks[a] as number })),
	}));
	const yticks = [hi, (hi + lo) / 2, lo].map((v) => ({ y: sy(v), label: v.toFixed(0) }));
	const xticks = pts.length <= 8
		? pts.map((p) => ({ x: sx(p.x), label: xMode.value === 'length' ? p.x.toFixed(0) : String(p.x) }))
		: [x0, (x0 + x1) / 2, x1].map((v) => ({ x: sx(v), label: v.toFixed(0) }));
	return { series, yticks, xticks };
});

const trend = computed(() => {
	// Simple first-to-last delta on the primary visible axis — enough to say "forces are climbing"
	// without implying a fitted wear model this data doesn't support.
	const a = AXES.find((x) => visAxes.value[x]);
	if (!a) return null;
	const vals = points.value.map((p) => p.peaks[a]).filter((v): v is number => v != null);
	if (vals.length < 2) return null;
	const first = vals[0], last = vals[vals.length - 1];
	if (!first) return null;
	return { axis: a, pct: ((last - first) / Math.abs(first)) * 100, first, last };
});

function toggleAxis(a: Axis) {
	const on = AXES.filter((x) => visAxes.value[x]);
	if (visAxes.value[a] && on.length <= 1) return;
	visAxes.value = { ...visAxes.value, [a]: !visAxes.value[a] };
}
</script>

<template>
	<div class="wear">
		<div class="wt-tools">
			<button v-for="a in AXES" :key="a" class="tbtn axchip" :class="{ on: visAxes[a] }"
				:style="visAxes[a] ? { color: AXIS_COLOR[a], borderColor: AXIS_COLOR[a] } : {}"
				@click="toggleAxis(a)">{{ a }}</button>
			<span class="wt-sep"></span>
			<button class="tbtn" :class="{ on: groupBy === 'edge' }" title="Passes made with this insert edge"
				@click="groupBy = 'edge'">Edge</button>
			<button class="tbtn" :class="{ on: groupBy === 'sample' }" title="Passes made on this sample"
				@click="groupBy = 'sample'">Sample</button>
			<span class="wt-sep"></span>
			<button class="tbtn" :class="{ on: xMode === 'sequence' }" @click="xMode = 'sequence'">Pass</button>
			<button class="tbtn" :class="{ on: xMode === 'length' }" :disabled="!lengthAvailable"
				:title="lengthAvailable ? 'Cumulative cutting length' : 'No cutting length recorded on these operations'"
				@click="xMode = 'length'">Length</button>
		</div>

		<div v-if="!detail" class="wt-empty">Select an operation to see its wear trend</div>
		<div v-else-if="loading" class="wt-empty">Loading…</div>
		<div v-else-if="error" class="wt-empty err">{{ error }}</div>
		<div v-else-if="!groupAvailable" class="wt-empty">
			This operation has no {{ groupBy === 'edge' ? 'insert edge' : 'sample' }} recorded, so its passes
			can't be grouped. <template v-if="groupBy === 'edge'">Try grouping by sample.</template>
		</div>
		<div v-else-if="!geom" class="wt-empty">
			Not enough passes yet — a trend needs at least two completed operations on this
			{{ groupBy === 'edge' ? 'edge' : 'sample' }}.
		</div>
		<template v-else>
			<svg class="wt-svg" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
				<line v-for="(t, i) in geom.yticks" :key="'g' + i" :x1="ML" :x2="W - MR" :y1="t.y" :y2="t.y"
					stroke="currentColor" stroke-opacity="0.12" stroke-width="0.6" />
				<text v-for="(t, i) in geom.yticks" :key="'yl' + i" :x="ML - 6" :y="t.y + 3" class="tick" text-anchor="end">{{ t.label }}</text>
				<text v-for="(t, i) in geom.xticks" :key="'xl' + i" :x="t.x" :y="H - MB + 14" class="tick" text-anchor="middle">{{ t.label }}</text>
				<text :x="(ML + W - MR) / 2" :y="H - 3" class="axis-label" text-anchor="middle">
					{{ xMode === 'length' ? 'Cumulative cutting length (mm)' : 'Pass' }}
				</text>
				<template v-for="s in geom.series" :key="s.axis">
					<path :d="s.d" fill="none" :stroke="s.color" stroke-width="1.6" />
					<circle v-for="(p, i) in s.dots" :key="i" :cx="p.cx" :cy="p.cy" :r="p.current ? 4 : 2.6"
						:fill="p.current ? s.color : 'var(--theme--background, #fff)'" :stroke="s.color" stroke-width="1.4">
						<title>{{ p.label }} · {{ s.axis }} {{ p.v.toFixed(1) }} N</title>
					</circle>
				</template>
			</svg>
			<p v-if="trend" class="wt-note">
				Peak {{ trend.axis }} {{ trend.pct >= 0 ? 'rose' : 'fell' }}
				<b :class="{ up: trend.pct >= 15 }">{{ Math.abs(trend.pct).toFixed(0) }}%</b>
				across {{ points.length }} passes ({{ trend.first.toFixed(0) }} → {{ trend.last.toFixed(0) }} N).
				<span class="wt-dim">Filled marker is the selected pass.</span>
			</p>
		</template>
	</div>
</template>

<style scoped>
.wear { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 8px 10px; gap: 6px;
	color: var(--theme--foreground, #1e293b); }
.wt-tools { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.wt-sep { width: 1px; height: 14px; background: var(--theme--border-color-subdued, #e7ebf0); margin: 0 2px; }
.tbtn { padding: 2px 8px; font: inherit; font-size: var(--fs-xs, 11px); font-weight: 700; cursor: pointer;
	color: var(--theme--foreground-subdued, #6b7684); background: var(--theme--background, #fff);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0); border-radius: 99px; }
.tbtn.on { color: #fff; background: #334155; border-color: #334155; }
.tbtn:disabled { opacity: 0.45; cursor: not-allowed; }
.axchip.on { background: var(--theme--background, #fff); }
.wt-svg { display: block; width: 100%; flex: 1 1 auto; min-height: 0; }
.tick { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; }
.axis-label { fill: var(--theme--foreground-subdued, #94a3b8); font-size: var(--fs-xs, 11px); }
.wt-empty { flex: 1; display: grid; place-items: center; text-align: center; padding: 12px;
	color: var(--theme--foreground-subdued, #98a2b3); font-size: var(--fs-sm, 12px); line-height: 1.5; }
.wt-empty.err { color: #dc2626; }
.wt-note { margin: 0; font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #6b7684); }
.wt-note b.up { color: #b45309; }
.wt-dim { opacity: 0.75; }
</style>
