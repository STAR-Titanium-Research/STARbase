// @d1/ui: the shared kit of the Explorer pages. Pure logic first (all unit-tested), then the
// components, which use Directus theme variables and the app's global components only.
//
// This file exports only what the extensions import. Everything else (the matrix builder, the
// roll-up internals, the vocabularies...) is used inside the kit and tested by importing its module
// directly. Add an export here when an extension needs it, not before. A page that only needs the
// link mapping and not the Vue components (the force app) imports "@d1/ui/recordRoute".

// Links
export { recordRoute, collectionRoute, dataStudioRoute } from './recordRoute';
export { analysisLink, processLabel } from './process';
export type { AnalysisLink } from './process';
export { rollupOperationsFilter, ROLLUP_OPERATION_FIELDS, rollupTargets } from './rollupLinks';
export type { RollupTarget } from './rollupLinks';
export { projectScopeFilter, sampleProjectScopeFilter } from './projectScope';

// Display helpers and error predicates
export { formatDate, formatNumber, formatQuantity, errorText, asRecord, isNotVisible, isForbidden } from './format';
export { humanise, TEST_DONE_STATUSES, TEST_STATUS_ORDER } from './status';
export { estimateMassGrams } from './mass';
export { buildLife, truncatedNotes } from './life';
export type { LifeItem, TraceResponse } from './life';
export { linkedFiles, shareFiles } from './linkedFiles';
export type { LinkedFile } from './linkedFiles';
export { paramColumns, paramRows } from './params';
export type { ParamRow } from './params';
export { summaryCount, summaryGroups } from './summary';
export { splitSubjects, TEST_SUBJECT_FIELDS } from './testSubjects';
export type { TestSubjects } from './testSubjects';
export type { ElementRow } from './composition';

// Campaigns, projects, activity
export { campaignTypeLabel, operationCategoryFor } from './campaign/campaignType';
export {
	DEFAULT_WEEKS, weeklyActivity, datesByKey,
} from './activity';
export type { WeeklyActivity } from './activity';
export { fetchActivityRows } from './activityRows';
export { projectRole, projectStatusLabel, filterProjects, campaignProgress, countsByKey } from './projects';
export type { ProjectRow, ProjectRole, RoleFilter, StatusFilter, CampaignProgress, ForceRows } from './projects';
export {
	CURRENT_USER, ownedByMe, samplesMine, projectsMine, campaignsMine, forceErrorOnMyOperations, forcePendingOperations,
	failedTests, ownerlessSamples,
} from './mine';

// Composables
export { useItems } from './composables/useItems';
export { useRequestGate } from './composables/useRequestGate';
export { LIST_CAP, useSections } from './composables/useSections';
export type { SectionState } from './composables/useSections';
export { useFieldDefs } from './composables/useFieldDefs';

// Components
export { default as RecordHeader } from './components/RecordHeader.vue';
export { default as StatTile } from './components/StatTile.vue';
export { default as StatusBadge } from './components/StatusBadge.vue';
export { default as RecordLink } from './components/RecordLink.vue';
export { default as Section } from './components/Section.vue';
export { default as LoadState } from './components/LoadState.vue';
export { default as NotVisible } from './components/NotVisible.vue';
export { default as KeyValueGrid } from './components/KeyValueGrid.vue';
export type { KeyValue } from './components/KeyValueGrid.vue';
export { default as ProgressBar } from './components/ProgressBar.vue';
export { default as Sparkline } from './components/Sparkline.vue';
export { default as CompositionBar } from './components/CompositionBar.vue';
export { default as EditDrawer } from './components/EditDrawer.vue';
export { default as CampaignWorkbench } from './campaign/CampaignWorkbench.vue';
