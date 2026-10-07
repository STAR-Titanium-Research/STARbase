<script setup lang="ts">
import { computed } from 'vue';
import type { WeekInfo } from '../activity';

// Operations and tests per week as two small lines on ONE shared scale (never two y-axes).
//
// Chart rules (dataviz skill): 2px lines, recessive baseline, a marker on the latest week, identity
// never by colour alone (tests are dashed, and the legend names both series), colours from the
// Directus theme so light and dark both work, an accessible title and description, and the weekly
// numbers on hover as native tooltips. The numbers are also in the `<desc>` for screen readers.
//
// The viewBox is fixed and the SVG scales uniformly, so strokes and markers keep their shape; pass
// a wider `width` (and `height`) for the full-width variant.
const props = withDefaults(
	defineProps<{
		ops: number[];
		tests: number[];
		/** The weeks the two series cover (same length), used for the hover text. */
		weeks?: WeekInfo[];
		width?: number;
		height?: number;
		showLegend?: boolean;
		/** Accessible title; a default naming the totals is generated. */
		title?: string;
	}>(),
	{ width: 260, height: 36, showLegend: true },
);

let counter = 0;
const uid = `d1-spark-${++counter}-${Math.random().toString(36).slice(2, 7)}`;

const PAD = 4;
const n = computed(() => Math.max(props.ops.length, props.tests.length));
const max = computed(() => Math.max(1, ...props.ops, ...props.tests));
const totalOps = computed(() => props.ops.reduce((a, b) => a + b, 0));
const totalTests = computed(() => props.tests.reduce((a, b) => a + b, 0));
const empty = computed(() => totalOps.value + totalTests.value === 0);

const x = (i: number) => (n.value <= 1 ? props.width / 2 : PAD + (i * (props.width - 2 * PAD)) / (n.value - 1));
const y = (v: number) => props.height - PAD - (v / max.value) * (props.height - 2 * PAD);
const baseline = computed(() => props.height - PAD);

function path(values: number[]): string {
	return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
}
const opsPath = computed(() => path(props.ops));
const testsPath = computed(() => path(props.tests));

const colWidth = computed(() => (n.value > 0 ? props.width / n.value : props.width));
const hover = computed(() =>
	Array.from({ length: n.value }, (_, i) => {
		const o = props.ops[i] ?? 0;
		const t = props.tests[i] ?? 0;
		const w = props.weeks?.[i];
		const when = w ? `Week of ${w.start} (ISO ${w.isoYear}-W${String(w.isoWeek).padStart(2, '0')})` : `Week ${i + 1}`;
		return {
			i,
			left: i * colWidth.value,
			text: `${when}: ${o} operation${o === 1 ? '' : 's'}, ${t} test${t === 1 ? '' : 's'}`,
		};
	}),
);

const heading = computed(
	() =>
		props.title ??
		`Operations and tests per week over the last ${n.value} weeks: ${totalOps.value} operation${totalOps.value === 1 ? '' : 's'}, ${totalTests.value} test${totalTests.value === 1 ? '' : 's'}`,
);
const description = computed(() =>
	empty.value ? 'No activity in this period.' : `Peak week has ${max.value} record${max.value === 1 ? '' : 's'}.`,
);
</script>

<template>
	<figure class="d1-spark">
		<svg
			:viewBox="`0 0 ${width} ${height}`"
			role="img"
			:aria-labelledby="`${uid}-t ${uid}-d`"
			preserveAspectRatio="xMidYMid meet"
		>
			<title :id="`${uid}-t`">{{ heading }}</title>
			<desc :id="`${uid}-d`">{{ description }}</desc>
			<line class="base" :x1="PAD" :x2="width - PAD" :y1="baseline" :y2="baseline" />
			<template v-if="n > 0">
				<path class="line tests" :d="testsPath" />
				<path class="line ops" :d="opsPath" />
				<circle v-if="ops.length" class="dot ops" :cx="x(ops.length - 1)" :cy="y(ops[ops.length - 1])" r="3" />
				<circle v-if="tests.length" class="dot tests" :cx="x(tests.length - 1)" :cy="y(tests[tests.length - 1])" r="3" />
				<!-- Hit targets wider than the marks, so hover works on any week. -->
				<rect v-for="h in hover" :key="h.i" class="hit" :x="h.left" y="0" :width="colWidth" :height="height">
					<title>{{ h.text }}</title>
				</rect>
			</template>
		</svg>
		<figcaption v-if="showLegend" class="legend">
			<span class="key"><i class="swatch ops" />Operations {{ totalOps }}</span>
			<span class="key"><i class="swatch tests" />Tests {{ totalTests }}</span>
			<span v-if="empty" class="none">No activity</span>
		</figcaption>
	</figure>
</template>

<style scoped>
.d1-spark { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
svg { width: 100%; height: auto; display: block; overflow: visible; }
.base { stroke: var(--theme--border-color-subdued); stroke-width: 1; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.line.ops { stroke: var(--theme--primary); }
.line.tests { stroke: var(--theme--secondary, var(--theme--foreground-subdued)); stroke-dasharray: 5 3; }
/* A 2px ring in the card colour keeps the two end markers apart when they coincide. */
.dot { stroke: var(--theme--background); stroke-width: 2; }
.dot.ops { fill: var(--theme--primary); }
.dot.tests { fill: var(--theme--secondary, var(--theme--foreground-subdued)); }
.hit { fill: transparent; }
.hit:hover { fill: var(--theme--background-accent, rgba(128, 128, 128, 0.12)); opacity: 0.5; }
.legend { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 11.5px; color: var(--theme--foreground-subdued); }
.key { display: inline-flex; align-items: center; gap: 5px; }
.swatch { display: inline-block; width: 14px; height: 0; border-top: 2px solid var(--theme--primary); }
.swatch.tests { border-top: 2px dashed var(--theme--secondary, var(--theme--foreground-subdued)); }
.none { font-style: italic; }
</style>
