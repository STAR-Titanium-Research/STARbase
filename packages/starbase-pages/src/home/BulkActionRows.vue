<script setup lang="ts">
import { computed } from 'vue';
import type { DetailLine } from '@d1/ui';

// The rows of one expanded bulk action (admin Home, Bulk actions): the record code, what happened to it, why, and what a revert did to it. A table, because
// the lines are the same four things each; wide ones scroll inside their own box, never the page. The column of revert outcomes appears only when some row has one.
const props = defineProps<{
	lines: DetailLine[] | null;
	loading: boolean;
	error: string;
	/** The rows belong to a revert: there is no revert column. */
	isRevert: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
const showRevert = computed(() => !props.isRevert && !!props.lines?.some((l) => l.revert));
</script>

<template>
	<div class="rows">
		<p v-if="loading && !lines" class="d1-note" role="status">Loading the records…</p>
		<template v-if="error">
			<p class="d1-note bad" role="alert">{{ error }}</p>
			<button type="button" class="btn" @click="emit('retry')">Try again</button>
		</template>
		<p v-else-if="lines && !lines.length" class="d1-note">This action has no records.</p>
		<div v-else-if="lines" class="scroll" tabindex="0" role="region" aria-label="Records of this action">
			<table>
				<thead>
					<tr>
						<th scope="col">Record</th>
						<th scope="col">Result</th>
						<th scope="col">Why</th>
						<th v-if="showRevert" scope="col">Revert</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="l in lines" :key="l.key">
						<th scope="row" class="code">{{ l.code }}</th>
						<td><span class="tag" :class="l.result.tone">{{ l.result.label }}</span></td>
						<td class="why">{{ l.reason }}</td>
						<td v-if="showRevert" class="why">
							<template v-if="l.revert">
								<span class="tag" :class="l.revert.tone">{{ l.revert.label }}</span>
								<span v-if="l.revert.reason" class="reason"> {{ l.revert.reason }}</span>
							</template>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>

<style scoped>
.rows { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; min-width: 0; }
.scroll { max-width: 100%; max-height: 320px; overflow: auto; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-surface); }
.scroll:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-sm, 12px); }
th, td { padding: 5px 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--d1-line); }
thead th { position: sticky; top: 0; background: var(--d1-tile); color: var(--d1-dim); font-size: var(--fs-xs, 11px); font-weight: 700; white-space: nowrap; }
tbody tr:last-child > * { border-bottom: 0; }
.code { font-weight: 600; white-space: nowrap; }
.why { color: var(--d1-dim); overflow-wrap: anywhere; min-width: 12em; }
.reason { color: var(--d1-dim); }
.tag { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 700; white-space: nowrap; border: 1px solid var(--d1-line); background: var(--d1-tile); }
.tag.ok { color: var(--d1-ok); }
.tag.dim { color: var(--d1-dim); }
.tag.warn { color: var(--d1-warn); }
.tag.bad { color: var(--d1-bad); }
.btn {
	height: 28px; padding: 0 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.btn:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.btn:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
