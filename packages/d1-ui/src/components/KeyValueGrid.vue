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

// Label/value pairs in a responsive grid. Empty values are left out unless `showEmpty`, so a page
// does not fill up with dashes.
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
.d1-kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px 24px; margin: 0; }
.pair { min-width: 0; }
dt {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
}
dd { margin: 2px 0 0; font-size: 14px; overflow-wrap: anywhere; }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.unit { margin-left: 4px; font-size: 12px; color: var(--theme--foreground-subdued); }
.link { color: var(--theme--primary); font-weight: 600; text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
