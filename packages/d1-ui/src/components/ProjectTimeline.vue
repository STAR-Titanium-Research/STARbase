<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import './tokens.css';
import { statusStyle } from '../status';
import {
	RANGE_OPTIONS, dayLabel, dayOf, emptyText, timelineData, timelineXTicks, weekLabel, type PlannedInput, type TimelineCampaignInput, type TimelineRange,
} from '../record/projectTimeline';
import SegmentedControl from './SegmentedControl.vue';

// The Project page's timeline: one SVG on one time axis (the project bar, its dated campaigns, done work per ISO week stacked with
// operations at the base, planned work as hollow marks on the baseline, a Today line). Everything drawn comes from projectTimeline();
// this only maps it to pixels. The width is measured, so the SVG is re-drawn at its own size (text stays text-sized, never a stretched viewBox).
// Spec: docs/superpowers/specs/2026-10-20-project-page-hero-design.md, "Timeline"; chart rules DESIGN.md 5b.
const props = defineProps<{
	project: { code?: string; start: string | null; end: string | null };
	campaigns: readonly TimelineCampaignInput[];
	/** Dates of the done operations and tests. */
	ops: readonly (string | null | undefined)[];
	tests: readonly (string | null | undefined)[];
	plannedOps: readonly PlannedInput[];
	plannedTests: readonly PlannedInput[];
	/** The activity read hit its row cap: the oldest records are missing. */
	truncated?: boolean;
	today?: Date;
}>();
const range = defineModel<TimelineRange>('range', { default: 'all' });

const uid = `d1-tl-${Math.random().toString(36).slice(2, 8)}`;
const host = ref<HTMLElement | null>(null);
// The tooltip is positioned inside `.plot`, so the pointer is measured against it (not the whole section, which also holds the header).
const plotEl = ref<HTMLElement | null>(null);
const width = ref(0);
let observer: ResizeObserver | null = null;
onMounted(() => {
	width.value = host.value?.clientWidth ?? 0;
	if (host.value && typeof ResizeObserver !== 'undefined') {
		observer = new ResizeObserver(() => { width.value = host.value?.clientWidth ?? width.value; });
		observer.observe(host.value);
	}
});
onBeforeUnmount(() => observer?.disconnect());

const dateText = (value: string | null, none: string) => {
	const ms = dayOf(value);
	return ms === null ? none : dayLabel(ms);
};

const W = computed(() => Math.max(260, width.value || 640));
const narrow = computed(() => W.value < 520);
const plotL = computed(() => (narrow.value ? 0 : 64) + 30);
const plotR = computed(() => W.value - 6);

// Two steps, so a width change only recomputes the x ticks: the dates are parsed and binned once per input or range change.
const model = computed(() =>
	timelineData({
		project: props.project, campaigns: props.campaigns, ops: props.ops, tests: props.tests,
		plannedOps: props.plannedOps, plannedTests: props.plannedTests, today: props.today ?? new Date(), range: range.value,
	}),
);
const xTicks = computed(() => timelineXTicks(model.value.domain, Math.max(3, Math.floor((plotR.value - plotL.value) / 72))));

const G = computed(() => {
	const m = model.value;
	const [x0, x1] = m.domain;
	const X = (ms: number) => plotL.value + ((ms - x0) / (x1 - x0)) * (plotR.value - plotL.value);
	const clamp = (v: number) => Math.max(plotL.value, Math.min(plotR.value, v));
	const rowsTop = 18;
	const rowH = narrow.value ? 28 : 20;
	const bar = (y: number) => (narrow.value ? y + 6 : y + 2);
	const label = (y: number) => ({ x: narrow.value ? plotL.value : 0, y: narrow.value ? y + 1 : y + 12 });
	let y = rowsTop;
	const rows: { key: string; text: string; lx: number; ly: number; x: number; y: number; w: number; cls: string; tip: string; fade: boolean }[] = [];
	if (m.project) {
		const p = props.project;
		const x = clamp(X(m.project.start));
		rows.push({
			key: 'project', text: 'Project', lx: label(y).x, ly: label(y).y, x, y: bar(y), w: Math.max(2, clamp(X(m.project.end)) - x), cls: 'span strong',
			tip: `Project${p.code ? ` ${p.code}` : ''}: ${dateText(p.start, 'no start date')} to ${dateText(p.end, 'no end date')}`,
			fade: m.project.openEnd,
		});
		y += rowH + 2;
	}
	for (const c of m.campaigns) {
		const x = clamp(X(c.start));
		rows.push({
			key: c.id, text: c.code, lx: label(y).x, ly: label(y).y, x, y: bar(y), w: Math.max(3, clamp(X(c.end)) - x),
			cls: c.status === 'active' ? 'span strong' : c.status === 'planned' ? 'span planned' : c.status === 'on_hold' ? 'span hold' : 'span',
			tip: `Campaign ${c.code} · ${c.name} · ${statusStyle('campaign', c.status)?.label ?? c.status} · ${dayLabel(c.start)} to ${dayLabel(c.end)}`, fade: false,
		});
		y += rowH;
	}
	const actTop = y + 30;
	const actH = W.value > 1000 ? 110 : W.value > 700 ? 88 : 64;
	const base = actTop + actH;
	const Y = (v: number) => base - (v / m.y.top) * actH;
	const wk = Math.max(1.5, X(x0 + 7 * 86_400_000) - X(x0) - 2);
	const bars = m.weeks.flatMap((w) => {
		const x = X(w.ms) + 1;
		const ho = base - Y(w.ops);
		const ht = base - Y(w.tests);
		const rx = Math.min(2, wk / 2);
		const tip = `Week of ${dayLabel(w.ms)} · ${w.ops} operation${w.ops === 1 ? '' : 's'} · ${w.tests} test${w.tests === 1 ? '' : 's'}`;
		return [{ key: `o${w.ms}`, cls: 'op', x, y: base - ho, w: wk, h: ho, rx, tip: '' },
			{ key: `t${w.ms}`, cls: 'test', x, y: base - ho - (ho > 0 && ht > 0 ? 2 : 0) - ht, w: wk, h: ht, rx, tip: '' },
			{ key: `h${w.ms}`, cls: 'hit', x: x - 1, y: actTop, w: wk + 2, h: actH, rx: 0, tip }].filter((b) => b.h > 0);
	});
	const marks = m.planned.map((p) => ({
		key: `${p.kind}${p.date}`, kind: p.kind, x: X(p.date), y: base - 7,
		tip: `Planned ${dayLabel(p.date)} · ${p.n} ${p.kind === 'op' ? 'operation' : 'test'}${p.n === 1 ? '' : 's'}`,
	}));
	const xt = xTicks.value.map((t) => ({ ...t, x: X(t.ms) }));
	const yt = m.y.ticks.map((v) => ({ v, y: Y(v) }));
	return { rows, rowsTop, actTop, base, H: base + 24, bars, marks, xt, yt, todayX: X(m.today), fadeX: clamp(X(m.today)) };
});

const tip = ref<{ text: string; x: number; y: number } | null>(null);
function onMove(e: MouseEvent) {
	const text = (e.target as SVGElement).getAttribute?.('data-tip');
	const box = plotEl.value?.getBoundingClientRect();
	if (!text || !box) { tip.value = null; return; }
	tip.value = { text, x: Math.min(Math.max(e.clientX - box.left, 90), Math.max(90, box.width - 90)), y: e.clientY - box.top };
}

const hasPlanned = computed(() => model.value.planned.length > 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const plannedTotals = computed(() => {
	let ops = 0;
	let tests = 0;
	for (const p of model.value.planned) { if (p.kind === 'op') ops += p.n; else tests += p.n; }
	return { ops, tests };
});
const ariaLabel = computed(() => {
	const base = `Timeline of project ${props.project.code ?? ''} with operations and tests per week`;
	if (!hasPlanned.value) return base;
	const { ops, tests } = plannedTotals.value;
	return `${base}, and planned work: ${[ops ? plural(ops, 'operation') : '', tests ? plural(tests, 'test') : ''].filter(Boolean).join(' and ')} on ${plural(new Set(model.value.planned.map((p) => p.date)).size, 'date')}`;
});
const statusText = (status: string) => statusStyle('campaign', status)?.label ?? status;
const lastOp = computed(() => (model.value.lastOp === null ? 'none' : dayLabel(model.value.lastOp)));
const lastTest = computed(() => (model.value.lastTest === null ? 'none' : dayLabel(model.value.lastTest)));
</script>

<template>
	<section ref="host" class="d1-timeline" :aria-labelledby="`${uid}-h`">
		<div class="head">
			<h2 :id="`${uid}-h`">Timeline</h2>
			<div class="legend">
				<span><i class="key op" />Operations</span>
				<span><i class="key test" />Tests</span>
				<template v-if="hasPlanned">
					<span><i class="key ring" />Planned operation</span>
					<span><i class="key dia" />Planned test</span>
				</template>
				<span><i class="key today" />Today</span>
			</div>
			<SegmentedControl v-model="range" :options="RANGE_OPTIONS" label="Timeline range" />
		</div>
		<p v-if="model.empty" class="empty">{{ emptyText(range) }}</p>
		<div v-else ref="plotEl" class="plot">
			<svg :viewBox="`0 0 ${W} ${G.H}`" :width="W" :height="G.H" role="img" :aria-label="ariaLabel" @mousemove="onMove" @mouseleave="tip = null">
				<defs>
					<linearGradient :id="`${uid}-fade`" x1="0" x2="1">
						<stop offset="0" style="stop-color: var(--d1-dim)" />
						<stop offset="1" style="stop-color: var(--d1-dim); stop-opacity: 0" />
					</linearGradient>
				</defs>
				<line v-for="t in G.xt" :key="`xg${t.ms}`" class="grid" :x1="t.x" :x2="t.x" :y1="G.rowsTop" :y2="G.base" />
				<line v-for="t in G.yt.slice(1)" :key="`yg${t.v}`" class="grid" :x1="plotL" :x2="plotR" :y1="t.y" :y2="t.y" />
				<template v-for="r in G.rows" :key="r.key">
					<text class="rowlabel" :x="r.lx" :y="r.ly">{{ r.text }}</text>
					<rect :class="r.cls" :x="r.x" :y="r.y" :width="r.w" height="12" rx="4" :data-tip="r.tip" />
					<rect v-if="r.fade && plotR - G.fadeX > 4" :x="G.fadeX" :y="r.y" :width="Math.min(64, plotR - G.fadeX)" height="12" :fill="`url(#${uid}-fade)`" />
				</template>
				<rect v-for="b in G.bars" :key="b.key" :class="b.cls" :x="b.x" :y="b.y" :width="b.w" :height="b.h" :rx="b.rx" :data-tip="b.tip || undefined" />
				<template v-for="p in G.marks" :key="p.key">
					<circle v-if="p.kind === 'op'" class="mark op" :cx="p.x" :cy="p.y" r="4.5" :data-tip="p.tip" />
					<path v-else class="mark test" :d="`M${p.x} ${p.y - 5.5}l5.5 5.5-5.5 5.5-5.5-5.5z`" :data-tip="p.tip" />
				</template>
				<text class="rowlabel" :x="narrow ? plotL : 0" :y="G.actTop - 8">Per week (operations and tests)</text>
				<line class="axis" :x1="plotL" :x2="plotL" :y1="G.actTop" :y2="G.base" />
				<line class="axis" :x1="plotL" :x2="plotR" :y1="G.base" :y2="G.base" />
				<g v-for="t in G.yt" :key="`y${t.v}`">
					<line v-if="t.v" class="axis" :x1="plotL - 4" :x2="plotL" :y1="t.y" :y2="t.y" />
					<text :x="plotL - 7" :y="t.y + 4" text-anchor="end">{{ t.v }}</text>
				</g>
				<g v-for="t in G.xt" :key="`x${t.ms}`">
					<line class="axis" :x1="t.x" :x2="t.x" :y1="G.base" :y2="G.base + 4" />
					<text :x="t.x" :y="G.base + 16" text-anchor="middle">{{ t.label }}</text>
				</g>
				<line class="today-line" :x1="G.todayX" :x2="G.todayX" :y1="G.rowsTop - 2" :y2="G.base" />
				<text class="today-label" :x="G.todayX" :y="G.rowsTop - 6" text-anchor="middle">Today</text>
			</svg>
			<div v-if="tip" class="tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">{{ tip.text }}</div>
		</div>
		<p class="last">
			<span>Last operation <b>{{ lastOp }}</b></span>
			<span>Last test <b>{{ lastTest }}</b></span>
			<span v-if="model.undated.length" :title="model.undated.join(', ')">Undated: <b>{{ model.undated.length }}</b></span>
		</p>
		<p v-if="truncated" class="note">Based on the newest records: the activity read hit its limit, so older weeks are missing.</p>
		<table v-if="model.weeks.length" class="d1-sr-only">
			<caption>Operations and tests per week</caption>
			<thead><tr><th>Week</th><th>Week of</th><th>Operations</th><th>Tests</th></tr></thead>
			<tbody>
				<tr v-for="w in model.weeks" :key="w.ms"><td>{{ weekLabel(w) }}</td><td>{{ dayLabel(w.ms) }}</td><td>{{ w.ops }}</td><td>{{ w.tests }}</td></tr>
			</tbody>
		</table>
		<table v-if="model.planned.length" class="d1-sr-only">
			<caption>Planned work</caption>
			<thead><tr><th>Date</th><th>Kind</th><th>Count</th></tr></thead>
			<tbody>
				<tr v-for="p in model.planned" :key="`${p.kind}${p.date}`"><td>{{ dayLabel(p.date) }}</td><td>{{ p.kind === 'op' ? 'Operations' : 'Tests' }}</td><td>{{ p.n }}</td></tr>
			</tbody>
		</table>
		<table v-if="model.campaigns.length" class="d1-sr-only">
			<caption>Campaigns with dates</caption>
			<thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Start</th><th>End</th></tr></thead>
			<tbody>
				<tr v-for="c in model.campaigns" :key="c.id"><td>{{ c.code }}</td><td>{{ c.name }}</td><td>{{ statusText(c.status) }}</td><td>{{ dayLabel(c.start) }}</td><td>{{ dayLabel(c.end) }}</td></tr>
			</tbody>
		</table>
		<p v-if="model.undated.length" class="d1-sr-only">Campaigns without dates: {{ model.undated.join(', ') }}</p>
	</section>
</template>

<style scoped>
.d1-timeline { position: relative; min-width: 0; container-type: inline-size; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin: 0 0 6px; }
.head h2 { margin: 0; font-size: var(--fs-md, 13px); font-weight: 650; line-height: 1.3; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; flex: 1; min-width: 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
/* Narrow: the title and the range control share the first line, the legend takes the second. */
@container (max-width: 560px) {
	.head > :nth-child(3) { order: 2; margin-left: auto; }
	.legend { order: 3; flex-basis: 100%; }
}
.key { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: -1px; border-radius: 2px; }
.key.op { background: var(--d1-chart-1); }
.key.test { background: var(--d1-chart-2); }
.key.ring { border-radius: 99px; border: 2px solid var(--d1-chart-1); }
.key.dia { width: 9px; height: 9px; border: 2px solid var(--d1-chart-2); border-radius: 0; transform: rotate(45deg); margin: 0 6px 0 2px; }
.key.today { width: 2px; height: 11px; border-radius: 0; background: var(--theme--foreground); margin: 0 6px 0 4px; }
.plot { position: relative; }
svg { display: block; max-width: 100%; overflow: visible; }
svg text { fill: var(--d1-dim); font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums; }
svg .rowlabel { fill: var(--theme--foreground); font-weight: 600; }
.axis { stroke: var(--d1-dim); stroke-width: 1; }
.grid { stroke: var(--d1-line); stroke-width: 1; }
.today-line { stroke: var(--theme--foreground); stroke-width: 1.5; }
svg .today-label { fill: var(--theme--foreground); font-weight: 700; }
/* Light bars (complete, cancelled, on hold) must reach 3:1 on the surface in both themes: the theme's hairline colours are about 1.3:1. */
.span { fill: color-mix(in srgb, var(--d1-dim) 72%, var(--d1-surface)); }
.span.strong { fill: var(--d1-dim); }
.span.planned { fill: var(--d1-surface); stroke: var(--d1-dim); stroke-width: 1.5; }
.span.hold { fill: color-mix(in srgb, var(--d1-dim) 22%, var(--d1-surface)); stroke: var(--d1-dim); stroke-width: 1.5; stroke-dasharray: 4 3; }
.op { fill: var(--d1-chart-1); }
.test { fill: var(--d1-chart-2); }
.hit { fill: transparent; }
.hit:hover { fill: var(--d1-tint, rgba(128, 128, 128, 0.12)); }
.mark { fill: var(--d1-surface); stroke-width: 2; stroke-linejoin: round; }
.mark.op { stroke: var(--d1-chart-1); }
.mark.test { stroke: var(--d1-chart-2); }
.empty { display: flex; align-items: center; min-height: 38px; margin: 0; padding: 5px 12px; border-radius: 10px; background: var(--d1-tile); font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.last { display: flex; flex-wrap: wrap; gap: 2px 16px; margin: 6px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.last b { color: var(--theme--foreground); font-weight: 600; }
.note { margin: 4px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.tip { position: absolute; z-index: 2; pointer-events: none; padding: 4px 8px; border-radius: 6px; white-space: nowrap; transform: translate(-50%, calc(-100% - 8px)); background: var(--theme--foreground); color: var(--d1-surface); font-size: var(--fs-xs, 11px); }
</style>
