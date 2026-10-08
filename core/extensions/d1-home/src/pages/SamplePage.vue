<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import {
	EditDrawer, HiddenLink, useCanUpdate, LoadState, NotVisible, RecordHeader, RecordLink, Section, StatusBadge,
	buildLife, dataStudioRoute, truncatedNotes,
} from '@d1/ui';
import { useSampleData } from './sample/useSampleData';
import SampleOverview from './sample/SampleOverview.vue';
import LifeStrip from './sample/LifeStrip.vue';
import SampleRecords from './sample/SampleRecords.vue';
import SampleFiles from './sample/SampleFiles.vue';

// Sample page: everything about one physical sample on one screen, with every related record a
// link to its own page. Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md.
const props = defineProps<{ id: string }>();

const { sample, loading, notVisible, error, elements, campaigns, operations, tests, files, trace, hidden, reload } =
	useSampleData(toRef(props, 'id'));

const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('physical_samples', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
	reload();
	refreshCanUpdate();
}

const code = computed(() => sample.value?.sample_code ?? 'Sample');
const studioTo = computed(() => dataStudioRoute('physical_samples', props.id));
const life = computed(() => (trace.value.data ? buildLife(trace.value.data) : []));
const notes = computed(() => (trace.value.data ? truncatedNotes(trace.value.data) : []));
const coOwners = computed(() =>
	(Array.isArray(sample.value?.co_owners) ? sample.value.co_owners : [])
		.map((c: any) => [c?.user_id?.first_name, c?.user_id?.last_name].filter(Boolean).join(' '))
		.filter(Boolean)
		.join(', '),
);
const campaignRows = computed(() => campaigns.value.data.map((c: any) => c.campaign_id).filter((c: any) => c?.campaign_id));
// A campaign link whose campaign the user may not read: the junction row is visible through the
// sample, the campaign comes back as null (row-level visibility, ADR-0011).
const hiddenCampaigns = computed(() => campaigns.value.data.length - campaignRows.value.length);

// /d1-report/* are endpoint pages (printable HTML), not app routes: open them in a new tab, same
// session, as the Home page does.
const openReport = (path: string) => window.open(path, '_blank', 'noopener');
const printLabel = () => openReport(`/d1-report/label?ids=${encodeURIComponent(props.id)}`);
const openReportPage = () => openReport(`/d1-report/sample/${encodeURIComponent(props.id)}`);
</script>

<template>
	<private-view :title="code">
		<div class="sample-page">
			<LoadState v-if="loading && !sample" loading loading-text="Loading sample…" />

			<NotVisible v-else-if="notVisible" what="sample" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="sample">
				<RecordHeader :code="code" :title="sample.nickname" kind="Sample" icon="science">
					<template #crumbs>
						<router-link to="/home">Home</router-link>
						<template v-if="sample.project_id">
							<span>›</span>
							<RecordLink collection="projects" :id="sample.project_id.project_id">
								{{ sample.project_id.project_code }}
							</RecordLink>
						</template>
						<template v-else-if="hidden.data.project_id">
							<span>›</span><HiddenLink label="Project" />
						</template>
						<template v-for="c in campaignRows" :key="c.campaign_id">
							<span>›</span>
							<RecordLink collection="campaigns" :id="c.campaign_id">{{ c.campaign_code || c.name || 'Campaign' }}</RecordLink>
						</template>
						<template v-if="hiddenCampaigns > 0">
							<span>›</span><HiddenLink :label="hiddenCampaigns === 1 ? 'Campaign' : `${hiddenCampaigns} campaigns`" />
						</template>
					</template>
					<template #status><StatusBadge kind="sample" :value="sample.current_status" /></template>
					<template #meta>
						<span v-if="sample.owner_person_id">Owner: {{ sample.owner_person_id.full_name }}</span>
						<span v-if="coOwners">Co-owners: {{ coOwners }}</span>
						<span v-if="sample.project_id?.project_name">{{ sample.project_id.project_name }}</span>
						<span v-if="sample.export_controlled" class="export">Export controlled</span>
					</template>
					<template #actions>
						<v-button v-if="canUpdate !== false" small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
						<v-button small secondary @click="printLabel"><v-icon name="label" small left />Print label</v-button>
						<v-button small secondary @click="openReportPage"><v-icon name="picture_as_pdf" small left />Report</v-button>
						<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
					</template>
				</RecordHeader>

				<Section title="Overview">
					<SampleOverview
						:sample="sample"
						:elements="elements.data"
						:elements-loading="elements.loading"
						:elements-error="elements.error"
					/>
				</Section>

				<Section title="Life of the sample">
					<template #actions>
						<v-button small secondary :to="`/d1-lab-dashboard/graph?sample=${encodeURIComponent(id)}`">
							<v-icon name="hub" small left />Open lineage graph
						</v-button>
					</template>
					<LoadState :loading="trace.loading" :error="trace.error">
						<LifeStrip :items="life" />
						<p v-for="n in notes" :key="n" class="note">{{ n }}</p>
					</LoadState>
				</Section>

				<SampleRecords :operations="operations" :tests="tests" />
				<SampleFiles :files="files.data" :loading="files.loading" :error="files.error" />

				<EditDrawer
					v-model="editing"
					collection="physical_samples"
					:primary-key="id"
					:title="`Edit ${code}`"
					@saved="onSaved"
				/>
			</template>
		</div>
	</private-view>
</template>

<style scoped>
.sample-page {
	max-width: 1180px;
	margin: 0 auto;
	padding: 24px 32px 64px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground);
}
.sample-page :deep(.crumbs a) { color: var(--theme--primary); text-decoration: none; font-weight: 600; }
.sample-page :deep(.crumbs a:hover) { text-decoration: underline; }
.export { color: var(--theme--danger); font-weight: 650; }
.note { margin: 8px 0 0; font-size: 12.5px; color: var(--theme--warning); }
</style>
