<script setup lang="ts">
import { computed, ref } from 'vue';
import HiddenLink from './HiddenLink.vue';
import { capList, visibleFacts, type Fact } from '../record/facts';
import { scrollToSection } from '../record/scrollTo';

// Label/value rows: the label on the left in the secondary colour, the value on the right at weight
// 600 with its unit after it, a hairline under each row. Used in the rail (one column) and in the
// Details panels (as many columns as fit). Takes the items KeyValueGrid takes (label, value, mono,
// to, unit) as a subset of `Fact`, so a call site changes one tag. Empty facts are left out.
//
// Built from div and span, not dl/dt/dd: the Data Studio styles every `dl > div`, `dt` and `dd` for
// its own sidebar (a flex row, the value on one line cut with an ellipsis; KeyValueGrid had to set
// each of those properties again). Plain elements carry none of that, so only the rules below apply.
const props = withDefaults(defineProps<{ facts: Fact[]; columns?: 'auto' | 1 }>(), { columns: 'auto' });
const shown = computed(() => visibleFacts(props.facts));
const text = (v: Fact['value']) => (v === null || v === undefined ? '' : String(v));

// A multi-value fact shows six items and "N more"; the toggle opens the rest (per fact, by label).
const expanded = ref(new Set<string>());
function toggle(label: string) {
	const next = new Set(expanded.value);
	if (!next.delete(label)) next.add(label);
	expanded.value = next;
}
const listed = (f: Fact) => capList(f.list ?? [], expanded.value.has(f.label) ? Infinity : 6);
</script>

<template>
	<div v-if="shown.length" class="d1-facts" :class="{ one: columns === 1 }" role="list">
		<div v-for="f in shown" :key="f.label" class="row" role="listitem">
			<span class="label">{{ f.label }}</span>
			<span v-if="f.list?.length" class="value items">
				<template v-for="(item, i) in listed(f).shown" :key="i">
					<HiddenLink v-if="item.hidden" :label="item.label" />
					<router-link v-else-if="item.to" :to="item.to" class="link">{{ item.label }}</router-link>
					<span v-else>{{ item.label }}</span>
				</template>
				<button v-if="listed(f).more > 0" type="button" class="more" @click="toggle(f.label)">{{ listed(f).more }} more</button>
				<button v-else-if="expanded.has(f.label)" type="button" class="more" @click="toggle(f.label)">fewer</button>
			</span>
			<span v-else class="value" :class="{ mono: f.mono }">
				<template v-if="f.hidden">
					<HiddenLink v-if="text(f.value)" :label="text(f.value)" />
					<span v-else class="not-visible">not visible to you</span>
				</template>
				<router-link v-else-if="f.to" :to="f.to" class="link">{{ text(f.value) }}</router-link>
				<a v-else-if="f.anchor" :href="`#${f.anchor}`" class="link" @click="scrollToSection(f.anchor, $event)">{{ text(f.value) }}</a>
				<template v-else>{{ text(f.value) }}</template>
				<span v-if="f.unit && !f.hidden" class="unit">{{ f.unit }}</span>
			</span>
		</div>
	</div>
</template>

<style scoped>
/* Columns: as many as fit at 260px. In the rail (`one`) a single column, unless the layout sets
   --d1-fact-grid (RecordLayout does when it stacks the rail at the top of a narrow page). */
.d1-facts {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
	column-gap: 28px;
	margin: 0;
	padding: 0;
}
.d1-facts.one { grid-template-columns: var(--d1-fact-grid, minmax(0, 1fr)); }
.row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	min-width: 0;
	min-height: 28px;
	margin: 0;
	padding: 4px 0;
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	font-size: var(--fs-md, 13px);
	line-height: 1.35;
}
.label {
	flex: none;
	max-width: 50%;
	color: var(--d1-dim, var(--theme--foreground-subdued));
	overflow-wrap: anywhere;
}
/* Long values wrap, never an ellipsis. */
.value {
	min-width: 0;
	margin: 0;
	text-align: right;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
	color: var(--theme--foreground);
	white-space: normal;
	overflow-wrap: anywhere;
}
.items { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0 10px; }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.unit { margin-left: 4px; font-weight: 400; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.link { color: var(--d1-accent, var(--theme--primary)); text-decoration: none; }
.link:hover { text-decoration: underline; }
.not-visible { font-style: italic; font-weight: 400; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.more {
	padding: 0;
	border: 0;
	background: none;
	font: inherit;
	font-weight: 400;
	color: var(--d1-accent, var(--theme--primary));
	cursor: pointer;
}
.more:hover { text-decoration: underline; }
</style>
