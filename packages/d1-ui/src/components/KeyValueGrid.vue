<script setup lang="ts">
import { computed } from 'vue';

export interface KeyValue {
	label: string;
	value: string | number | null | undefined;
	/** Monospace, for codes and ids. */
	mono?: boolean;
	/** Makes the value a link to this app route. */
	to?: string;
	/** Unit shown after the value in a subdued colour (`mm`, `MPa`). */
	unit?: string;
}

// Label/value pairs as the force app's readout tiles: the value with its unit, the label under it.
// Empty values are left out unless `showEmpty`, so a page does not fill up with dashes.
const props = defineProps<{ items: KeyValue[]; showEmpty?: boolean }>();
const shown = computed(() =>
	props.items.filter((i) => props.showEmpty || (i.value !== null && i.value !== undefined && i.value !== '')),
);
const text = (v: KeyValue['value']) => (v === null || v === undefined || v === '' ? '—' : String(v));
</script>

<template>
	<dl v-if="shown.length" class="d1-kv">
		<div v-for="i in shown" :key="i.label" class="pair">
			<dt>{{ i.label }}</dt>
			<dd :class="{ mono: i.mono }">
				<router-link v-if="i.to" :to="i.to" class="link">{{ text(i.value) }}</router-link>
				<template v-else>{{ text(i.value) }}</template>
				<span v-if="i.unit && text(i.value) !== '—'" class="unit">{{ i.unit }}</span>
			</dd>
		</div>
	</dl>
</template>

<style scoped>
.d1-kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; margin: 0; }
/* The Data Studio styles every `dl > div`, `dt` and `dd` for its own sidebar (a flex row, a value
   on one line cut with an ellipsis). Those rules reach this list too, so each property they set is
   set again here: without that the label sits beside the value and long values are cut short.
   The value is drawn above its label; the markup keeps the label first. */
.pair {
	display: flex;
	flex-direction: column-reverse;
	justify-content: flex-end;
	gap: 1px;
	min-width: 0;
	margin: 0;
	padding: 7px 10px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 8px;
	background: var(--d1-tile, var(--theme--background-subdued));
}
dt {
	flex: none;
	margin: 0;
	font-size: var(--fs-xs, 11px);
	font-weight: 600;
	letter-spacing: 0.01em;
	line-height: 1.3;
	color: var(--d1-dim, var(--theme--foreground-subdued));
}
dd {
	flex: none;
	margin: 0;
	overflow: visible;
	white-space: normal;
	text-overflow: clip;
	overflow-wrap: anywhere;
	font-size: var(--fs-md, 13px);
	font-weight: 650;
	font-variant-numeric: tabular-nums;
	line-height: 1.3;
	color: var(--theme--foreground);
}
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.unit { margin-left: 4px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.link { color: var(--d1-accent, var(--theme--primary)); text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
