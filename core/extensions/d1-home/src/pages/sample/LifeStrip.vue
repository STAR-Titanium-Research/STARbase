<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { formatDate, type LifeItem } from '@d1/ui';

// The life of the sample as a left-to-right strip: stock, ancestors, this sample, operations and
// tests by date, descendants. It scrolls sideways and opens centred on this sample. On a narrow
// container (a tablet, a split view) the same list becomes a vertical timeline.
const props = defineProps<{ items: LifeItem[] }>();

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
			<li
				v-for="item in items"
				:key="item.key"
				:ref="(el) => setSelf(item, el)"
				class="node"
				:class="[`kind--${item.kind}`, { through: item.throughHidden }]"
			>
				<span class="dot" />
				<span class="kind">{{ KIND_LABEL[item.kind] }}</span>
				<router-link v-if="item.to" :to="item.to" class="label">{{ item.label }}</router-link>
				<span v-else class="label" :class="{ plain: item.kind === 'hidden' }">{{ item.label }}</span>
				<span v-if="item.sub" class="sub">{{ item.sub }}</span>
				<span v-if="item.date" class="date">{{ formatDate(item.date, 'undated') }}</span>
				<span v-else-if="item.kind === 'operation' || item.kind === 'test'" class="date">undated</span>
				<span v-if="item.throughHidden" class="via" title="Every path to this record goes through a sample you do not have permission to read.">
					via a sample you cannot see
				</span>
			</li>
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
	width: 150px;
	padding: 20px 12px 4px 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
	font-size: 13px;
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
	box-shadow: 0 0 0 3px var(--theme--background);
}
.kind--stock { --d1-dot: var(--theme--warning); }
.kind--operation { --d1-dot: var(--theme--success); }
.kind--test { --d1-dot: var(--theme--secondary); }
.kind--self { --d1-dot: var(--theme--primary); }
.kind--self .dot { width: 16px; height: 16px; top: -1px; }
.kind--hidden .dot { background: var(--theme--background); border: 2px dashed var(--theme--foreground-subdued); box-sizing: border-box; }

.kind {
	font-size: 10.5px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--theme--foreground-subdued);
}
.label {
	font-weight: 650;
	overflow-wrap: anywhere;
	color: var(--theme--foreground);
	text-decoration: none;
}
a.label { color: var(--theme--primary); }
a.label:hover { text-decoration: underline; }
.kind--self .label { font-size: 15px; }
.label.plain { font-weight: 500; font-style: italic; color: var(--theme--foreground-subdued); }
.sub, .date, .via { font-size: 11.5px; color: var(--theme--foreground-subdued); overflow-wrap: anywhere; }
.via { font-style: italic; }
.through .label { opacity: 0.75; }

/* Narrow: the same steps as a vertical timeline. */
@container (max-width: 640px) {
	.strip { flex-direction: column; overflow: visible; padding: 0 0 0 4px; }
	.node { width: auto; padding: 0 0 18px 26px; }
	.node::before { top: 0; bottom: 0; left: 5px; right: auto; width: 2px; height: auto; }
	.dot { top: 2px; left: 0; }
	.kind--self .dot { top: 0; left: -2px; }
	.node:last-child::before { bottom: auto; height: 12px; }
}
</style>
