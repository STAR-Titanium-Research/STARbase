<script setup lang="ts">
import { computed } from 'vue';
import { LIST_CAP, LoadState, Section, StatusBadge, analysisLink, formatDate, formatQuantity, type SectionState } from '@d1/ui';

// Analysis of the operation's data: the force analysis of each .mat file (machining) or the
// imported FAST trace (sintering), with the dashboard that plots it. Cutting metrics stay in the
// Force dashboard; this only says what state each file is in and why it failed.
const props = defineProps<{
	operationId: string;
	category: string | null;
	force: SectionState<any[]>;
	fast: SectionState<any | null>;
}>();

const link = computed(() => analysisLink(props.operationId, props.category));
const capped = computed(() => props.force.data.length > LIST_CAP);
const rows = computed(() =>
	props.force.data.slice(0, LIST_CAP).sort((a, b) => fileName(a).localeCompare(fileName(b), undefined, { numeric: true })),
);
const fileName = (r: any) => r?.directus_files_id?.filename_download || r?.directus_files_id?.title || '(file)';
const isMachining = computed(() => props.category === 'machining');
</script>

<template>
	<Section
		v-if="isMachining"
		title="Force analysis"
		:count="force.loading ? null : rows.length"
		:empty="!force.loading && !force.error && !rows.length"
		empty-text="No force files have been picked up for analysis yet."
	>
		<template v-if="link && rows.length" #actions>
			<v-button small secondary :to="link.to"><v-icon name="show_chart" small left />{{ link.label }}</v-button>
		</template>
		<LoadState :loading="force.loading" :error="force.error">
			<p v-if="capped" class="capped">
				Showing the first {{ LIST_CAP }} force files. Open the Force dashboard for the rest.
			</p>
			<table class="d1-table">
				<thead><tr><th>File</th><th>Analysis</th><th>Diagnostics</th><th>Processed</th></tr></thead>
				<tbody>
					<template v-for="r in rows" :key="r.id">
						<tr>
							<td class="file">{{ fileName(r) }}</td>
							<td><StatusBadge kind="force" :value="r.status" /></td>
							<td><StatusBadge kind="diag" :value="r.diag_status" /></td>
							<td>{{ formatDate(r.processed_at, '') }}</td>
						</tr>
						<tr v-if="r.error_message || r.diag_error" class="errors">
							<td colspan="4">
								<p v-if="r.error_message" class="err"><strong>Analysis:</strong> {{ r.error_message }}</p>
								<p v-if="r.diag_error" class="err"><strong>Diagnostics:</strong> {{ r.diag_error }}</p>
							</td>
						</tr>
					</template>
				</tbody>
			</table>
		</LoadState>
	</Section>

	<Section
		v-if="category === 'sintering'"
		title="FAST run"
		:empty="!fast.loading && !fast.error && !fast.data"
		empty-text="No FAST trace has been imported for this run yet."
	>
		<template v-if="link && fast.data" #actions>
			<v-button small secondary :to="link.to"><v-icon name="show_chart" small left />{{ link.label }}</v-button>
		</template>
		<LoadState :loading="fast.loading" :error="fast.error">
			<div v-if="fast.data" class="fast">
				<StatusBadge kind="force" :value="fast.data.status" />
				<span v-if="fast.data.recipe">Recipe {{ fast.data.recipe }}</span>
				<span v-if="fast.data.plant">{{ fast.data.plant }}</span>
				<span v-if="fast.data.run_start">Started {{ formatDate(fast.data.run_start) }}</span>
				<span v-if="fast.data.duration_s">{{ formatQuantity(fast.data.duration_s) }} s</span>
				<span v-if="fast.data.n_rows">{{ formatQuantity(fast.data.n_rows) }} rows</span>
				<p v-if="fast.data.error_message" class="err"><strong>Import:</strong> {{ fast.data.error_message }}</p>
			</div>
		</LoadState>
	</Section>
</template>

<style scoped>
.d1-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.d1-table th {
	text-align: left;
	padding: 6px 12px 6px 0;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
	border-bottom: 1px solid var(--theme--border-color);
}
.d1-table td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--theme--border-color-subdued); vertical-align: middle; }
.file { overflow-wrap: anywhere; font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: 12.5px; }
.capped { margin: 0 0 8px; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.errors td { padding-top: 0; }
.err { margin: 0 0 4px; font-size: 12.5px; color: var(--theme--danger); overflow-wrap: anywhere; }
.fast { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; font-size: 13.5px; }
.fast .err { flex-basis: 100%; }
</style>
