<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AppLink, chipText, chipTitle, daySummary, fitSplit, groupLife, splitSummary, type LifeDay, type LifeItem, type LifeStep } from '@d1/ui';

// The life of the sample as a left-to-right strip: stock, ancestors, this sample, then one node per
// day of operations and tests (a chip per record, the full pass code in its tooltip), descendants.
// When the steps are wider than the panel, the start (through this sample) and the latest steps
// stay and the middle ones fold into a split node; clicking it shows them all, and the strip then
// scrolls sideways. On a narrow container (a tablet, a split view) the same list becomes a vertical
// timeline, split the same way once it has more than NARROW_STEPS steps. The Operations and Tests panels below list every record in full; this
// strip tells the story.
const props = defineProps<{ items: LifeItem[] }>();
const steps = computed(() => groupLife(props.items));

// A busy day shows two rows of chips, then "+N more".
const CHIP_CAP = 16;
const open = ref(new Set<string>());
const shown = (day: LifeDay) => (open.value.has(day.key) ? day.items : day.items.slice(0, CHIP_CAP));
function toggle(day: LifeDay) {
	const next = new Set(open.value);
	if (!next.delete(day.key)) next.add(day.key);
	open.value = next;
}

const life = ref<HTMLElement | null>(null);
const strip = ref<HTMLElement | null>(null);
// This sample's node, found with a function ref (the nodes are a v-for).
let selfEl: HTMLElement | null = null;
const setSelf = (item: LifeItem, el: unknown) => {
	if (item.kind === 'self') selfEl = el as HTMLElement | null;
};

// The split. NARROW matches the container query below; SPLIT_WIDTH is the split node's CSS width.
const NARROW = 640;
const SPLIT_WIDTH = 170;
// Each step's width, measured with every step drawn (a step's width does not depend on the panel's).
const widths = ref<number[] | null>(null);
const available = ref(0);
const expanded = ref(false);
const selfIndex = computed(() => steps.value.findIndex((s) => s.type === 'item' && s.item.kind === 'self'));
// The vertical list has no width to fill, so it shows at most NARROW_STEPS steps, the split counted as one.
const NARROW_STEPS = 8;
const fit = computed(() => {
	if (available.value <= 0) return null;
	if (available.value <= NARROW) return fitSplit(steps.value.map(() => 1), NARROW_STEPS, 1, selfIndex.value);
	return widths.value && widths.value.length === steps.value.length
		? fitSplit(widths.value, available.value, SPLIT_WIDTH, selfIndex.value)
		: null;
});
const split = computed(() => (expanded.value ? null : fit.value));

type Row = LifeStep | { type: 'split'; key: string; hidden: LifeStep[] };
const rows = computed<Row[]>(() => {
	const all: Row[] = steps.value;
	const s = split.value;
	if (!s) return all;
	const hidden = steps.value.slice(s.head, steps.value.length - s.tail);
	return [...all.slice(0, s.head), { type: 'split', key: 'split', hidden }, ...all.slice(all.length - s.tail)];
});

function centreOnSelf() {
	const s = strip.value;
	const el = selfEl;
	if (!s || !el || s.scrollWidth <= s.clientWidth) return;
	s.scrollLeft = el.offsetLeft - s.clientWidth / 2 + el.clientWidth / 2;
}

async function measure() {
	widths.value = null;
	await nextTick();
	const s = strip.value;
	if (s && available.value > NARROW) widths.value = Array.from(s.children, (el) => (el as HTMLElement).getBoundingClientRect().width);
	await nextTick();
	centreOnSelf();
}

// Show the folded steps, scrolled so the first of them sits where the split node was.
async function expandSplit(event: MouseEvent) {
	const s = strip.value;
	const at = (event.currentTarget as HTMLElement).closest('li')!.offsetLeft - (s?.scrollLeft ?? 0);
	const first = split.value?.head ?? 0;
	expanded.value = true;
	await nextTick();
	const el = s?.children[first] as HTMLElement | undefined;
	if (s && el && available.value > NARROW) s.scrollLeft = el.offsetLeft - at;
}
function collapseSplit() {
	expanded.value = false;
	if (strip.value) strip.value.scrollLeft = 0;
}

let observer: ResizeObserver | null = null;
onMounted(() => {
	if (typeof ResizeObserver !== 'undefined' && life.value) {
		observer = new ResizeObserver(([entry]) => {
			available.value = entry.contentRect.width;
			if (available.value > NARROW && !widths.value) void measure();
		});
		observer.observe(life.value);
	} else centreOnSelf();
});
onBeforeUnmount(() => observer?.disconnect());
watch(
	() => props.items,
	() => {
		expanded.value = false;
		void measure();
	},
);

const KIND_LABEL: Record<string, string> = {
	stock: 'Raw stock',
	ancestor: 'Parent',
	operation: 'Operation',
	test: 'Test',
	descendant: 'Child',
	self: 'This sample',
	hidden: '',
};
</script>

<template>
	<div ref="life" class="life">
		<ol ref="strip" class="strip">
			<template v-for="row in rows" :key="row.key">
				<li v-if="row.type === 'split'" class="node split">
					<button type="button" class="split-btn" :aria-expanded="false" title="Show the steps in between" @click="expandSplit">
						<span class="dot" />
						<span class="kind">{{ splitSummary(row.hidden).label }}</span>
						<span v-for="line in splitSummary(row.hidden).lines" :key="line" class="sub">{{ line }}</span>
						<span class="show">Show all</span>
					</button>
				</li>
				<li v-else-if="row.type === 'day'" class="node day" :class="row.operations ? 'kind--operation' : 'kind--test'">
					<span class="dot" />
					<span class="kind">{{ row.dayText }}</span>
					<span class="label">{{ daySummary(row) }}</span>
					<ul class="chips">
						<li v-for="item in shown(row)" :key="item.key">
							<AppLink v-if="item.to" :to="item.to" class="chip" :class="`chip--${item.kind}`" :title="chipTitle(item)">{{ chipText(item) }}</AppLink>
							<span v-else class="chip" :class="`chip--${item.kind}`" :title="chipTitle(item)">{{ chipText(item) }}</span>
						</li>
					</ul>
					<button v-if="row.items.length > CHIP_CAP" type="button" class="more" @click="toggle(row)">
						{{ open.has(row.key) ? 'Show fewer' : `+${row.items.length - CHIP_CAP} more` }}
					</button>
				</li>
				<li
					v-else
					:ref="(el) => setSelf(row.item, el)"
					class="node"
					:class="[`kind--${row.item.kind}`, { through: row.item.throughHidden }]"
				>
					<span class="dot" />
					<span class="kind">{{ KIND_LABEL[row.item.kind] }}</span>
					<AppLink v-if="row.item.to" :to="row.item.to" class="label" :class="{ code: row.item.isCode }">{{ row.item.label }}</AppLink>
					<span v-else class="label" :class="{ code: row.item.isCode, plain: row.item.kind === 'hidden' }">{{ row.item.label }}</span>
					<span v-if="row.item.sub" class="sub">{{ row.item.sub }}</span>
					<span v-if="row.item.throughHidden" class="via" title="Every path to this record goes through a sample you do not have permission to read.">
						via a sample you cannot see
					</span>
				</li>
			</template>
		</ol>
		<button v-if="expanded && fit" type="button" class="more fold" @click="collapseSplit">Fold the steps in between</button>
	</div>
</template>

<style scoped>
.life { container-type: inline-size; }

.strip {
	list-style: none;
	margin: 0;
	/* 4px on top: overflow-x clips vertically too, and this sample's larger dot with its ring reaches 4px above the line. */
	padding: 4px 0 8px;
	display: flex;
	overflow-x: auto;
}
.node {
	position: relative;
	flex: 0 0 auto;
	/* As wide as its label, up to 196px: enough for a long code in two lines (at 150px a pass code
	   took four, and the strip's height was set by its longest code). */
	width: auto;
	min-width: 140px;
	max-width: 196px;
	padding: 22px 16px 4px 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
	font-size: var(--fs-sm, 12px);
}
/* the line through the dots */
.node::before {
	content: '';
	position: absolute;
	top: 6px;
	left: 0;
	right: 0;
	height: 2px;
	background: var(--theme--border-color);
}
.dot {
	position: absolute;
	top: 1px;
	left: 0;
	width: 12px;
	height: 12px;
	border-radius: 50%;
	background: var(--d1-dot, var(--theme--foreground-subdued));
	box-shadow: 0 0 0 3px var(--d1-surface, var(--theme--background));
}
.kind--stock { --d1-dot: var(--theme--warning); }
.kind--operation { --d1-dot: var(--theme--success); }
.kind--test { --d1-dot: var(--theme--secondary); }
.kind--self { --d1-dot: var(--d1-accent, var(--theme--primary)); }
.kind--self .dot { width: 16px; height: 16px; top: -1px; }
.kind--hidden .dot { background: var(--d1-surface, var(--theme--background)); border: 2px dashed var(--theme--foreground-subdued); box-sizing: border-box; }

.kind { font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.label {
	font-weight: 650;
	line-height: 1.35;
	overflow-wrap: anywhere;
	color: var(--theme--foreground);
	text-decoration: none;
}
a.label { color: var(--d1-accent, var(--theme--primary)); }
/* Only a code is set in monospace; an uncoded operation's label and a test's type are descriptions. */
.label.code { font-family: var(--theme--fonts--monospace--font-family, monospace); }
a.label:hover { text-decoration: underline; }
.kind--self .label { font-size: var(--fs-md, 13px); }
.label.plain { font-family: inherit; font-weight: 500; font-style: italic; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.sub, .via { font-size: var(--fs-xs, 11px); color: var(--d1-dim, var(--theme--foreground-subdued)); overflow-wrap: anywhere; }
.via { font-style: italic; }
.through .label { opacity: 0.75; }

/* A day: as wide as its chips, up to two rows' worth. */
.node.day { width: auto; min-width: 150px; max-width: 300px; }
.chips {
	list-style: none;
	margin: 4px 0 0;
	padding: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}
.chips li { min-width: 0; max-width: 100%; }
.chip {
	display: block;
	padding: 1px 6px 1px 5px;
	border-left: 3px solid var(--d1-chip, var(--theme--foreground-subdued));
	border-radius: 4px;
	background: var(--d1-tile, var(--theme--background-subdued));
	color: var(--d1-accent, var(--theme--primary));
	font-size: var(--fs-xs, 11px);
	line-height: 1.5;
	text-decoration: none;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
a.chip:hover { text-decoration: underline; }
.chip--operation { --d1-chip: var(--theme--success); font-family: var(--theme--fonts--monospace--font-family, monospace); }
.chip--test { --d1-chip: var(--theme--secondary); }
.more {
	align-self: flex-start;
	margin-top: 2px;
	padding: 0;
	border: 0;
	background: none;
	color: var(--d1-accent, var(--theme--primary));
	font: inherit;
	font-size: var(--fs-xs, 11px);
	font-weight: 600;
	cursor: pointer;
}
.more:hover { text-decoration: underline; }
.fold { display: block; margin: 4px 0 0 auto; }

/* The split: a fixed-width node (SPLIT_WIDTH in the script) on a dashed stretch of the line. */
.node.split { width: 170px; min-width: 0; max-width: none; box-sizing: border-box; }
.split::before {
	background: repeating-linear-gradient(to right, var(--theme--border-color) 0 6px, transparent 6px 11px);
}
.split .dot { background: var(--d1-surface, var(--theme--background)); border: 2px dashed var(--theme--foreground-subdued); box-sizing: border-box; }
.split-btn {
	all: unset;
	display: flex;
	flex-direction: column;
	gap: 2px;
	cursor: pointer;
	font-size: var(--fs-sm, 12px);
}
.split-btn:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 4px; }
.split-btn .kind { color: var(--theme--foreground); font-weight: 650; font-size: var(--fs-sm, 12px); }
.show { margin-top: 2px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); }
.split-btn:hover .show { text-decoration: underline; }

/* Narrow: the same steps as a vertical timeline. */
@container (max-width: 640px) {
	.strip { flex-direction: column; overflow: visible; padding: 0 0 0 4px; }
	.node, .node.day, .node.split { width: auto; max-width: none; padding: 0 0 18px 26px; }
	.split::before { background: repeating-linear-gradient(to bottom, var(--theme--border-color) 0 6px, transparent 6px 11px); }
	.node::before { top: 0; bottom: 0; left: 5px; right: auto; width: 2px; height: auto; }
	.dot { top: 2px; left: 0; }
	.kind--self .dot { top: 0; left: -2px; }
	.node:last-child::before { bottom: auto; height: 12px; }
}
</style>
