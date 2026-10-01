export { setForceHost, useForceHost, resetForceHost, authorizedFetch, resetAuthRefresh } from './host';
export type { ForceHost, ForceHostUser } from './host';
export { diagRequestError, DiagRequestError, describeRequestFailure } from './diagError';
export { openDiagSync, diagSyncName, debouncePublish } from './diagSync';
export type { DiagSyncMsg, DiagSyncChannel } from './diagSync';

export { default as ForceChart } from './ForceChart.vue';
export { default as SpectrumView } from './SpectrumView.vue';

export { computeSignalStats } from './signalStats';
export type { SignalStats } from './signalStats';
export * from './frmExport';

export { default as FrmCloud } from './FrmCloud.vue';
export { default as FrmOctree } from './FrmOctree.vue';
export { bucketEnvelope, buildSeriesEnvelope, cacheGet, cachePut, decimateCache, idxOfTime, parseCache } from './liveCache';
export type { Cache, EnvSeries } from './liveCache';
export { COLORMAPS, COLORMAP_LABELS, colormapLabel, axisAutoLimits } from './liveCloud';
export type { Axis, CloudChannel } from './liveCloud';
export type { SpeedMode } from './liveCloud';
export {
	defaultScale, applyParams, normalize, denormalize, sampleScale, sampleScaleAt, buildScaleLUT,
	lutKey, colorizeValues, withAutoRange, withOpenDisplay, OPEN_DISP,
} from './colorScale';
export { createScaleTexture, syncScaleTexture } from './scaleTexture';
export { useAutoColorScale } from './autoColorScale';
export type { AutoRange } from './autoColorScale';
export type { ColorScale } from './colorScale';
export { histogramFrom, createAccumulator } from './histogram';
export type { Histogram, HistogramAccumulator } from './histogram';
export { default as ColorBar } from './ColorBar.vue';
export { default as ColorScaleEditor } from './ColorScaleEditor.vue';
export { default as PlotModeFlyout } from './PlotModeFlyout.vue';
export { buildPath, alignRhoToBuckets } from './path';
export type {
	PathKind, PathParams, PathWindow, PathBounds, PathResult,
	TurningSpiralParams, LinearFeedParams, MachineXyzParams,
} from './path';
export { spindleAngle, toFixedFrame, AngleSourceUnavailableError } from './angle';
export type { AngleSource, AngleParams, FixedFrame } from './angle';
export { buildPolar } from './polar';
export type { PolarRadius, PolarParams, PolarResult } from './polar';
export { default as PolarPlot } from './PolarPlot.vue';

export { chainActive, chainSummary, defaultChain, fetchFiltered, fetchFilteredFft } from './filterChain';
export type { FilterChain } from './filterChain';

export { default as ForceDashboard } from './ForceDashboard.vue';

export { default as DiagnosticsWorkbench } from './DiagnosticsWorkbench.vue';
export { default as DiagOctreeView } from './DiagOctreeView.vue';
export { default as DiagScatter } from './DiagScatter.vue';
export { default as ClusterTable } from './ClusterTable.vue';
export { default as RecipePanel } from './RecipePanel.vue';
export { default as LayerPanel } from './LayerPanel.vue';
export { CLUSTER_PALETTE, clusterColorCss } from './clusterPalette';
export { fetchD1an, parseD1an, D1AN_MAGIC } from './diagAttrs';
export type { DiagAttrs } from './diagAttrs';
export { workingSetFromD1an, matches, computeStats, clusterStats, CHANNEL_ACCESSOR } from './selection';
export type { WorkingSet, Selection, SelectionStats, ChannelKey, ClusterRow } from './selection';

export {
	DEFAULT_RECIPE, STEP_META, recipeChannels, recipesEquivalent, CATEGORY_LABELS, CATEGORY_ORDER,
} from './recipeChannels';
export { recipeProblems } from './recipeChannels';
export type {
	Recipe, RecipeStep, ParamSpec, StepMeta, ChannelOption, RecipeProblem, StepCategory,
} from './recipeChannels';

export { fetchDiagPreview } from './diagPreview';
export type { DiagPreview } from './diagPreview';

export { fetchViewportCompute } from './diagViewport';
export type { ViewportStep, ViewportResult } from './diagViewport';

export { default as InfoTip } from './InfoTip.vue';
export { default as SpatialPanel } from './SpatialPanel.vue';
export { default as SignalPanel } from './SignalPanel.vue';
export {
	DIAG_PANEL_TYPES, DIAG_DEFAULT_LAYOUT, DIAG_LAYOUT_LS_KEY, loadDiagLayout, saveDiagLayout,
	newPanelInst,
} from './diagPanels';
export type { DiagPanelType, DiagPanelInst } from './diagPanels';
export {
	STEP_HELP, CHANNEL_HELP, PANEL_HELP, SCOPE_META, ACTION_HELP, scopeOf,
} from './diagHelp';
export type { StepScope, StepHelp } from './diagHelp';

export { fetchLayers, saveLayer, deleteLayer, layersForRequest } from './diagLayers';
export type { DiagLayer, LayerRole, LayerGeometry } from './diagLayers';

export { fetchRecipeLibrary, saveRecipe, deleteRecipe } from './diagRecipes';
export type { SavedRecipe } from './diagRecipes';
export { default as RecipeLibrary } from './RecipeLibrary.vue';

export { alignAndDiff } from './compare';
export type { AlignedDiff } from './compare';

export { diagnose, activeFindings, worstSeverity, CROP_COVERAGE_MIN } from './metadataDoctor';
export type { Finding, Dismissal, DoctorSeverity, DoctorFix } from './metadataDoctor';
