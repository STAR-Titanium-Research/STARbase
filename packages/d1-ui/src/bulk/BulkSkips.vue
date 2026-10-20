<script setup lang="ts">
// The skipped rows of a bulk action, grouped by reason and folded away until asked for: in the dialog's preview ("12 will be skipped")
// and in the toast ("12 skipped"). One <details>, so the keyboard and screen readers get the disclosure for free.
import { computed } from 'vue';
import { groupSkips } from './bulkModel';
import type { SkippedRow } from './bulkModel';

const props = defineProps<{
	/** The line that opens the list: "Why are 12 skipped?" or "12 skipped". */
	summary: string;
	rows: SkippedRow[];
}>();
const groups = computed(() => groupSkips(props.rows));
</script>

<template>
	<details v-if="rows.length" class="skips">
		<summary>{{ summary }}</summary>
		<section v-for="g in groups" :key="g.reason" class="group">
			<h3>{{ g.reason }} <span class="n">({{ g.rows.length }})</span></h3>
			<ul>
				<li v-for="r in g.rows" :key="r.id">{{ r.code }}</li>
			</ul>
		</section>
	</details>
</template>

<style scoped>
.skips { font-size: var(--fs-sm, 12px); color: var(--theme--foreground); }
summary { cursor: pointer; font-weight: 600; color: var(--d1-accent, var(--theme--primary)); }
summary:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 4px; }
.group { margin-top: 8px; }
h3 { margin: 0 0 2px; font-size: var(--fs-sm, 12px); font-weight: 700; }
.n { font-weight: 400; color: var(--d1-dim); }
ul { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 2px 12px; max-height: 120px; overflow-y: auto; color: var(--d1-dim); }
li { white-space: nowrap; }
</style>
