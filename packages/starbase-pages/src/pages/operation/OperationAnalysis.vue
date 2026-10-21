<script setup lang="ts">
import { computed } from 'vue';
import ConformRunSection from './ConformRunSection.vue';
import type { ConformRunData } from './useOperationData';
import { DataTable, LIST_CAP, LoadState, Section, StatusBadge, analysisLink, breakableParts, formatDate, formatQuantity, type SectionState } from '@d1/ui';

// Analysis of the operation's data: the force analysis of each .mat file (machining), the
// imported FAST trace (sintering) or the Conform run's log, window and summary (conform), with the dashboard that plots it. Cutting metrics stay in the
// Force dashboard; this only says what state each file is in and why it failed.
const props = defineProps<{
	operationId: string;
	category: string | null;
	force: SectionState<any[]>;
	fast: SectionState<any | null>;
	/** A Conform run's row, log and whether the log is hidden from this reader (conform only). */
	conform?: SectionState<ConformRunData | null>;
	equipmentId?: string | null;
	operationDate?: string | null;
	/** The reader may change the run (upload a log, set the window); the server still decides. */
	canEdit?: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const noConform: SectionState<ConformRunData | null> = { data: null, loading: false, error: '' };

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
		id="force-analysis"
		title="Force analysis"
		:count="force.loading ? null : rows.length"
		:empty="!force.loading && !force.error && !rows.length"
		empty-text="No force files have been picked up for analysis yet."
	>
		<template v-if="link && rows.length" #actions>
			<v-button x-small secondary :to="link.to"><v-icon name="show_chart" x-small left />{{ link.label }}</v-button>
		</template>
		<LoadState :loading="force.loading" :error="force.error">
			<p v-if="capped" class="d1-note capped">
				Showing the first {{ LIST_CAP }} force files. Open the Force dashboard for the rest.
			</p>
			<DataTable>
				<thead><tr><th>File</th><th class="fit">Analysis</th><th class="fit">Diagnostics</th><th class="fit">Processed</th></tr></thead>
				<tbody>
					<template v-for="r in rows" :key="r.id">
						<tr :class="{ failed: r.error_message || r.diag_error }">
							<td class="file mono"><template v-for="(part, i) in breakableParts(fileName(r))" :key="i">{{ part }}<wbr /></template></td>
							<td class="fit"><StatusBadge kind="force" :value="r.status" /></td>
							<td class="fit"><StatusBadge kind="diag" :value="r.diag_status" /></td>
							<td class="fit dim">{{ formatDate(r.processed_at, '') }}</td>
						</tr>
						<tr v-if="r.error_message || r.diag_error" class="errors">
							<td colspan="4">
								<p v-if="r.error_message" class="err"><strong>Analysis:</strong> {{ r.error_message }}</p>
								<p v-if="r.diag_error" class="err"><strong>Diagnostics:</strong> {{ r.diag_error }}</p>
							</td>
						</tr>
					</template>
				</tbody>
			</DataTable>
		</LoadState>
	</Section>

	<Section
		v-if="category === 'sintering'"
		id="fast-run"
		title="FAST run"
		:count="fast.loading ? null : fast.data ? 1 : 0"
		:empty="!fast.loading && !fast.error && !fast.data"
		empty-text="No FAST trace has been imported for this run yet."
	>
		<template v-if="link && fast.data" #actions>
			<v-button x-small secondary :to="link.to"><v-icon name="show_chart" x-small left />{{ link.label }}</v-button>
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

	<ConformRunSection
		v-if="category === 'conform'"
		:operation-id="operationId"
		:equipment-id="equipmentId ?? null"
		:operation-date="operationDate ?? null"
		:state="conform ?? noConform"
		:can-edit="canEdit ?? true"
		@changed="emit('changed')"
	/>
</template>

<style scoped>
/* A long name wraps after an underscore, dash or dot (the <wbr> in the template), never one
   character per line: `anywhere` would shrink the column's minimum to one character. */
.file { overflow-wrap: break-word; word-break: normal; font-size: var(--fs-sm); }
.capped { margin-bottom: 8px; }
/* The reason a file failed sits under its file with no rule between them: the file row drops its
   bottom border and the reason row its top padding. `tr.` raises both above DataTable's own
   `.d1-table td` (which would otherwise tie, and stylesheet order would decide). */
tr.failed td { border-bottom: 0; }
tr.errors td { padding-top: 0; }
.err { margin: 0 0 4px; font-size: var(--fs-sm); color: var(--d1-bad); overflow-wrap: anywhere; }
.fast { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; font-size: var(--fs-md); }
.fast .err { flex-basis: 100%; }
</style>
