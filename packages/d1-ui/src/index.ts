// @d1/ui: the shared kit of the Explorer pages. Pure logic first (all unit-tested), then the
// components, which use Directus theme variables and the app's global components only.
//
// This file exports only what the extensions import. Everything else (the matrix builder, the
// roll-up internals, the vocabularies...) is used inside the kit and tested by importing its module
// directly. Add an export here when an extension needs it, not before. A page that only needs the
// link mapping and not the Vue components (the force app) imports "@d1/ui/recordRoute".

// Links
export {
	assetUrl, canonicalPath, configureLinks, directusLinks, linkHref, openLink, resetLinks, resolveLink, serverUrl, starbaseLinks,
} from './links';
export type { LinkConfig, ResolvedLink } from './links';
export { recordRoute, collectionRoute, dataStudioRoute, indexRoute } from './recordRoute';
export { analysisLink, processLabel } from './process';
export type { AnalysisLink } from './process';
export { operationLabel, operationHeading, operationSampleLine, hasPassCode } from './operationLabel';
export { rollupOperationsFilter, ROLLUP_OPERATION_FIELDS, rollupTargets } from './rollupLinks';
export type { RollupTarget } from './rollupLinks';
export { readHiddenLinks } from './hiddenLinks';
export { createdRecord, CREATED_BUT_HIDDEN_MESSAGE, NO_PERSON_MESSAGE } from './createResult';
export { projectScopeFilter, sampleProjectScopeFilter } from './projectScope';

// Display helpers and error predicates
export { breakableParts, formatDate, formatNumber, formatQuantity, errorText, asRecord, isNotVisible, isForbidden } from './format';
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
	CURRENT_USER, projectInvestigatorFilter, ownedByMe, samplesMine, projectsMine, campaignsMine, forceErrorOnMyOperations, forcePendingOperations,
	failedTests, ownerlessSamples,
} from './mine';

// Composables
export { useItems } from './composables/useItems';
export { useRequestGate } from './composables/useRequestGate';
export { LIST_CAP, useSections } from './composables/useSections';
export type { SectionState } from './composables/useSections';
export { useFieldDefs } from './composables/useFieldDefs';
export { useCanUpdate } from './composables/useCanUpdate';
export {
	NOT_CAMPAIGN_OWNER_MESSAGE, NOT_OWNER_MESSAGE, NOT_PI_MESSAGE, NOT_YOUR_RECORD_MESSAGE, forbiddenReason, notOwnerMessage,
} from './canUpdate';

// Components
export { default as PageShell } from './components/PageShell.vue';
export { default as DataTable } from './components/DataTable.vue';
export { default as RecordCard } from './components/RecordCard.vue';
export { default as StatTile } from './components/StatTile.vue';
export { default as StatusBadge } from './components/StatusBadge.vue';
export { default as AppLink } from './components/AppLink.vue';
export { default as RecordLink } from './components/RecordLink.vue';
export { default as Section } from './components/Section.vue';
export { default as LoadState } from './components/LoadState.vue';
export { default as NotVisible } from './components/NotVisible.vue';
export { default as HiddenLink } from './components/HiddenLink.vue';
export { default as RecordLayout } from './components/RecordLayout.vue';
export { default as RecordRail } from './components/RecordRail.vue';
export { default as FactList } from './components/FactList.vue';
export { default as PageContents } from './components/PageContents.vue';
export type { Fact } from './record/facts';
export type { ContentsEntry } from './record/contents';
export { detailFacts, detailsCount } from './record/details';
export {
	operationKind, operationRailFacts, operationDetailBase, operationSampleCount, projectFact, campaignFact, sampleFact, personText,
} from './record/operationFacts';
export type { HiddenLinks } from './record/operationFacts';
export { testTypeText, testSample, testRailFacts, testDetailBase, testSubjectCount } from './record/testFacts';
export {
	sampleDims, sampleKind, sampleMassText, sampleCampaigns, coOwnerText, sampleRailFacts, sampleDetailBase,
} from './record/sampleFacts';
export type { SampleDims } from './record/sampleFacts';
export { dateRangeText, projectRailFacts, projectContents } from './record/projectFacts';
export type { ProjectCounts as ProjectRailCounts, ProjectContentsInput } from './record/projectFacts';
export { campaignCode, campaignRailFacts, campaignContents } from './record/campaignFacts';
export type { CampaignCounts, CampaignContentsInput } from './record/campaignFacts';
export { default as ProgressBar } from './components/ProgressBar.vue';
export { default as Sparkline } from './components/Sparkline.vue';
export { default as CompositionBar } from './components/CompositionBar.vue';
export { default as EditDrawer } from './components/EditDrawer.vue';
export { default as CampaignWorkbench } from './campaign/CampaignWorkbench.vue';
export { default as CampaignCard } from './campaign/CampaignCard.vue';
export { campaignCardStats, loadCampaignStats } from './campaign/campaignCardStats';
export type { CampaignStats } from './campaign/campaignCardStats';
export { default as CampaignProgressBars } from './campaign/CampaignProgress.vue';
export { useCampaignData } from './campaign/useCampaignData';
export type { CampaignData } from './campaign/useCampaignData';

// Explorer navigation: host contract, sidebar tree, index-page configs
export { EXPLORER_HOST, setExplorerHostFactory, useExplorerHost } from './host';
export { guessAdmin } from './hostAdmin';
export type { ExplorerHost, HostApi, HostField, HostRequestConfig, HostResponse } from './host';
export { NAV_GROUPS, BOOKMARK_VISIBILITY_FILTER, buildNav, bookmarkVisibleToUser, pickBookmarkId, linkForBookmark } from './nav/navConfig';
export type { NavLink, NavGroup, Bookmark, VisibleNav } from './nav/navConfig';
export { default as ExplorerNav } from './nav/ExplorerNav.vue';
export { default as Finder } from './finder/Finder.vue';
export { isFinderShortcut, isModalOpen, shouldOpenFinder } from './finder/finderNav';
export { useFinderShortcut } from './finder/useFinderShortcut';
export { default as ScanResultCard } from './finder/ScanResultCard.vue';
export { isScanStarted, normalizeScan, displayText, resolveLabel } from './finder/scan';
export type { ScanApi, ScanOutcome, FailReason } from './finder/scan';
export { cameraSupport, cameraErrorMessage, decodeSize, DECODE_INTERVAL_MS } from './finder/scanCamera';
export { INDEX_DEFS, indexDefBySlug, indexDefByCollection } from './index/indexConfig';
export type { IndexDef, ColumnDef, FilterDef, SelectAction } from './index/indexConfig';
export { thumbKind, thumbFields, imageField, hasDrawableDims, fileId, assetThumbUrl } from './index/thumbs';
export type { ThumbKind } from './index/thumbs';
export { plotKind, plotRequests, mergePlots } from './index/plotData';
export type { RowPlots } from './index/plotData';
export { default as IndexPage } from './index/IndexPage.vue';

// Admin Home rules (the crawler online test, the overview shape, the Needs attention rows)
export { CRAWLER_ONLINE_MS, ago, attentionView, crawlerOnline, isAuthRefusal, normaliseOverview, overviewTime, ownerlessRows, ownerlessTotal } from './adminHome';
export type { AdminOverview, AttentionTile, Crawler, CrawlerState, Fingerprints, MissingFiles, Ownerless, OwnerlessRow } from './adminHome';

// Label printing (pure logic: templates, pagination, text fit, QR payload, HTML renderer)
export {
	FIELD_KEYS, QR_KEYS, FIELD_SIZES, ARRANGEMENTS, MEDIA, toLabelSample, isPrintableSample, templateFromRow, validateTemplate, slotPositions, paginate, paginateCounts, fitText,
	SIZE_PT, MIN_PT, buildQrPayload, parseQrPayload, effectiveQrKeys, QR_HEADER, renderLabelDocument, chooseQr, moduleMm, MIN_MODULE_MM, WARN_MODULE_MM, contactEmailOf, parseContactInput, contactLine, EMAIL_PATTERN,
	LABEL_SAMPLE_FIELDS, MAX_COPIES, MEMBER_COLUMNS, parseSelectionQuery, parseCodes, pickerFilter, clampCopies, clampStart, slotsPerPage,
	countLabels, summaryText, classifyTemplates, pickTemplate, canEditTemplate, blankTemplate, copyAsNew, draftOf, templatePayload,
	saveErrorText, moveField, sampleEntries, buildLbxDownload, isLbxTemplate, LBX_TAPE_MM,
} from './labels';
export type {
	QrKey, FieldKey, FieldSize, Arrangement, Media, LabelField, LabelTemplate, LabelSample, Slot, PaginateOptions, FittedText, ParsedQrPayload,
	RenderOptions, RenderedLabels, QrModules, QrLevel, ChosenQr, Measure, BrokenTemplate, CountedSample, LabelEntry, LbxDownload,
} from './labels';

// Frequently used (Home panel and the visit pings; the server half is core/extensions/d1-usage)
export {
	PAGE_KEYS, PAGES, RECORD_COLLECTIONS, createRepeatFilter, mergeWithSuggestions, pageEntry, pageTarget, pinEntry, readDismissed,
	recordEntries, recordRequest, recordTarget, removeEntry, restoreEntry, revertPin, routeTarget, splitRecordTarget, suggestedPageEntries,
	withoutDismissed, writeDismissed,
} from './usage';
export type { PageInfo, RepeatFilter, UsageEntry, UsageKind } from './usage';
