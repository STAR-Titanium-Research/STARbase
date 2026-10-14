<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { AppLink, chipText, chipTitle, daySummary, groupLife, type LifeDay, type LifeItem } from '@d1/ui';

// The life of the sample as a left-to-right strip: stock, ancestors, this sample, then one node per
// day of operations and tests (a chip per record, the full pass code in its tooltip), descendants.
// It scrolls sideways and opens centred on this sample. On a narrow container (a tablet, a split
// view) the same list becomes a vertical timeline. The Operations and Tests panels below list every
// record in full; this strip tells the story.
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

const strip = ref<HTMLElement | null>(null);
// This sample's node, found with a function ref (the nodes are a v-for).
let selfEl: HTMLElement | null = null;
const setSelf = (item: LifeItem, el: unknown) => {
	if (item.kind === 'self') selfEl = el as HTMLElement | null;
};

function centreOnSelf() {
	const s = strip.value;
	const el = selfEl;
	if (!s || !el || s.scrollWidth <= s.clientWidth) return;
	s.scrollLeft = el.offsetLeft - s.clientWidth / 2 + el.clientWidth / 2;
}

onMounted(centreOnSelf);
watch(() => props.items, () => nextTick(centreOnSelf));

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
	<div class="life">
		<ol ref="strip" class="strip">
			<template v-for="step in steps" :key="step.key">
				<li v-if="step.type === 'day'" class="node day" :class="step.operations ? 'kind--operation' : 'kind--test'">
					<span class="dot" />
					<span class="kind">{{ step.dayText }}</span>
					<span class="label">{{ daySummary(step) }}</span>
					<ul class="chips">
						<li v-for="item in shown(step)" :key="item.key">
							<AppLink v-if="item.to" :to="item.to" class="chip" :class="`chip--${item.kind}`" :title="chipTitle(item)">{{ chipText(item) }}</AppLink>
							<span v-else class="chip" :class="`chip--${item.kind}`" :title="chipTitle(item)">{{ chipText(item) }}</span>
						</li>
					</ul>
					<button v-if="step.items.length > CHIP_CAP" type="button" class="more" @click="toggle(step)">
						{{ open.has(step.key) ? 'Show fewer' : `+${step.items.length - CHIP_CAP} more` }}
					</button>
				</li>
				<li
					v-else
					:ref="(el) => setSelf(step.item, el)"
					class="node"
					:class="[`kind--${step.item.kind}`, { through: step.item.throughHidden }]"
				>
					<span class="dot" />
					<span class="kind">{{ KIND_LABEL[step.item.kind] }}</span>
					<AppLink v-if="step.item.to" :to="step.item.to" class="label" :class="{ code: step.item.isCode }">{{ step.item.label }}</AppLink>
					<span v-else class="label" :class="{ code: step.item.isCode, plain: step.item.kind === 'hidden' }">{{ step.item.label }}</span>
					<span v-if="step.item.sub" class="sub">{{ step.item.sub }}</span>
					<span v-if="step.item.throughHidden" class="via" title="Every path to this record goes through a sample you do not have permission to read.">
						via a sample you cannot see
					</span>
				</li>
			</template>
		</ol>
	</div>
</template>

<style scoped>
.life { container-type: inline-size; }

.strip {
	list-style: none;
	margin: 0;
	padding: 0 0 8px;
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

/* Narrow: the same steps as a vertical timeline. */
@container (max-width: 640px) {
	.strip { flex-direction: column; overflow: visible; padding: 0 0 0 4px; }
	.node, .node.day { width: auto; max-width: none; padding: 0 0 18px 26px; }
	.node::before { top: 0; bottom: 0; left: 5px; right: auto; width: 2px; height: auto; }
	.dot { top: 2px; left: 0; }
	.kind--self .dot { top: 0; left: -2px; }
	.node:last-child::before { bottom: auto; height: 12px; }
}
</style>
