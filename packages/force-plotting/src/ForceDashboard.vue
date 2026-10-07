<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { GridLayout, GridItem } from 'grid-layout-plus';
import { useRoute, useRouter } from 'vue-router';
import ForceChart from './ForceChart.vue';
import { pickMode, type FrmMode } from './frmMode';
import { perKeyComputed } from './perKeyComputed';
import LoadingOverlay from './LoadingOverlay.vue';
import { sameStage, stageInfo, type LoadStage, type StageInfo } from './loadStage';
import { createLoadToken } from './loadToken';
import { createActivationQueue, createOpGuard } from './opGuard';
import SpectrumView from './SpectrumView.vue';
import FrmCloud from './FrmCloud.vue';
import FrmOctree from './FrmOctree.vue';
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue';
import PlotHelp from './PlotHelp.vue';
import { formatPointInfo, recentreWindow, type PointInfo, type PointMenuEvent } from './cloudPick';
import WearTrend from './WearTrend.vue';
import type { SpeedMode } from './liveCloud';
import { axisAutoLimits } from './liveCloud';
import { defaultScale, withAutoRange, withOpenDisplay, type ColorScale } from './colorScale';
import { useAutoColorScale } from './autoColorScale';
import { histogramFrom, type Histogram } from './histogram';
import ColorScaleEditor from './ColorScaleEditor.vue';
import PlotModeFlyout from './PlotModeFlyout.vue';
import { cacheGet, cachePut, decimateCache, parseCache, type Cache } from './liveCache';
import { alignMeasuredRho, measuredRhoSpan, type TurningSpiralParams } from './path';
import { computeAutoCode } from './operationCode';
import { activeFindings, diagnose, worstSeverity, type Finding } from './metadataDoctor';
import { computeSignalStats, resolveStatsWindow, type SignalStats } from './signalStats';
import { statsCsvColumns } from './statsCsv';
import { AXIS_MAPS, DEFAULT_AXIS_MAP, axisMapKey, computeCuttingMetrics, formatAxisMap, opKindFromSubtype, parseAxisMap, removeLegacyAxisMap, resolveAxisMap, usesSpiralDiameter, writeAxisMapForSubtype, type Metric } from './cuttingMetrics';
import { type FilterChain, chainActive, chainSummary, defaultChain, fetchFiltered, fetchFilteredFft } from './filterChain';
import { useForceHost } from './host';
import { saveChartImage, type ChartSnapshot } from './chartExport';
import { downloadText, safeFilePart, toCsv, useCopyFeedback, type CsvColumn } from './csvExport';
import { debounce } from './debounce';
import { cropWindowSec, diffEnvelopes, diffWindow } from './compare';
import { createPendingCrop } from './pendingCrop';
import {
	decodeViewState, encodeViewState, incomingViewDecision, VIEW_AXES, VIEW_QUERY_KEYS,
	type ViewAxis, type ViewChartMode, type ViewState, type ViewZSeries,
} from './viewState';

const host = useForceHost();
const api = host.api;
const route = useRoute();
const router = useRouter();

// Roles that see every sample/operation regardless of ownership (Administrator,
// Lab Admin). Everyone else (e.g. Lab Member) only sees analyses whose sample
// owner, operation owner, or operation operator resolves to their own
// people.person_id — this dashboard-level filter, not a Directus policy change,
// since it's the one place this scoping was asked for today.
const ADMIN_ROLE_IDS = new Set(['2ec9ca82-2dd5-42b5-b89f-1f4c6bf6ec4f', '10000001-0000-0000-0000-000000000001']);
const myPersonId = ref<string | null>(null);
// currentUser.role may be either the role object ({id}) or the bare id string,
// depending on how far the user store has hydrated — handle both, plus Directus's
// admin_access flag, so an actual admin is never wrongly ownership-filtered.
const isAdminRole = computed(() => {
	const cu = host.currentUser() as any;
	const roleId = typeof cu?.role === 'string' ? cu.role : cu?.role?.id;
	return ADMIN_ROLE_IDS.has(roleId) || cu?.role?.admin_access === true || cu?.admin_access === true;
});

const AXES = VIEW_AXES;
type Axis = ViewAxis;
const AXIS_COLOR: Record<Axis, string> = { Fx: '#dc2626', Fy: '#16a34a', Fz: '#2563eb' };  // red / green / blue

const loading = ref(true);
const rows = ref<any[]>([]);

const sampleSearch = ref('');
const opSearch = ref('');
// selectedSampleId: which sample is highlighted (set by clicking a sample OR an
// operation, so the samples list always shows where the current selection lives).
// filterSampleId: which sample the Operations list is scoped to — set ONLY by
// clicking a sample, so picking an operation never hides its siblings.
const selectedSampleId = ref<string | null>(null);
const filterSampleId = ref<string | null>(null);
const selectedRowId = ref<string | null>(null);
const detail = ref<any | null>(null);
const loadingDetail = ref(false);

const chartMode = ref<ViewChartMode>('force');
// Same set/order the Record page's plot panels offer, picked the same way (from the panel's title).
// Its first entry is the time-domain view under each page's own name for it ("Force" here, "Time"
// there -- both stay as they were).
const CHART_MODES = [
	{ key: 'force', label: 'Force' },
	{ key: 'fft', label: 'FFT' },
	{ key: 'psd', label: 'Power', title: 'Power spectrum (dB)' },
	{ key: 'spectrogram', label: 'Spectro', title: 'Time × frequency heatmap' },
	{ key: 'waterfall', label: 'Waterfall', title: 'Stacked spectra over time' },
];
const SPECTRAL_MODES = ['psd', 'spectrogram', 'waterfall'] as const;
const isSpectral = computed(() => (SPECTRAL_MODES as readonly string[]).includes(chartMode.value));
const hoverIndex = ref<number | null>(null);   // shared across the 3 charts
const axis = ref<Axis>('Fz');

// ---- Chart zoom -----------------------------------------------------------------
// The 3 axis charts share one x-window (they share an x-axis: time in force mode,
// frequency in FFT). zoomStart/zoomEnd are in x-units; null => full extent. A
// rect-zoom tool lets the user rubber-band a window; wheel zoom always works.
const zoomStart = ref<number | null>(null);
const zoomEnd = ref<number | null>(null);
const rectZoomTool = ref(false);
const zoomed = computed(() => zoomStart.value != null || zoomEnd.value != null);
function onChartZoom(v: { start: number; end: number } | null) {
	if (!v) { zoomStart.value = null; zoomEnd.value = null; return; }
	zoomStart.value = v.start; zoomEnd.value = v.end;
}
function resetZoom() { zoomStart.value = null; zoomEnd.value = null; }
// A new operation or a Force<->FFT switch changes the x-axis meaning entirely, so
// drop any stale zoom window.
watch([chartMode, selectedRowId], resetZoom);

// ---- Live mode ----------------------------------------------------------------
// Live augments the existing view in place (no separate panel): the FRM column
// becomes an interactive WebGL point cloud, the force plots gain draggable crop
// handles, and the operation's plot-driving metadata becomes editable. Everything
// recomputes client-side from the loaded live cache. A "Process" button (Tier 2)
// re-renders at a finer resolution on the host (archive is host-only).
// Default the point-cloud-vs-image choice by connection speed (a saved preference in
// the layout localStorage overrides this): fast link -> interactive cloud, slow/metered
// -> the lighter static image.
function fastConnection(): boolean {
	const c = (navigator as any).connection;
	if (!c) return true;                                   // unknown -> assume fast
	if (c.saveData) return false;                          // data-saver -> image
	if (typeof c.effectiveType === 'string') return c.effectiveType === '4g';
	if (typeof c.downlink === 'number') return c.downlink >= 5;   // Mbps
	return true;
}
const frmMode = ref<FrmMode>(fastConnection() ? 'lite' : 'figure');
// What the USER last asked for, kept apart from the mode actually shown: an op without a live cache
// (or no selected op at all) forces 'figure' for as long as it is on screen, and that must not
// become the choice the next op starts from (#94). Only chooseMode() writes it.
const preferredMode = ref<FrmMode>(frmMode.value);
// Editable geometry (seeded from the cache on load; user edits drive the cloud).
const cropStartSec = ref(0);
const cropEndSec = ref(0);
// "Save crop as official" flow (see saveCropAsOfficial). Two-step: the button reveals an inline
// Confirm so the write only ever happens on an explicit apply, never mid-drag.
const cropSavePrompt = ref(false);
const cropSaving = ref(false);
const cropSavedMsg = ref('');
// Set only by an actual user drag (onCropEdit below), reset on op change / successful save.
// cropDirty (below) compares two independently-stored values — the cache header's csSec vs
// cut_start_idx/sample_rate — with only a 1-sample tolerance, so it can read true from float
// noise alone with no drag ever happening. The combined "Save changes" dialog gates on this
// instead, so editing Notes alone never silently pins a crop override that was previously NULL
// (= "follow the derived crop, survive reprocessing" per the crop_start_idx_override migration).
// The standalone "Save crop" button/flow (liveOn && cropDirty, ~line 2010) is untouched — it
// already required a deliberate click before this fix and still does.
const cropTouched = ref(false);
const editFeed = ref(0.1);
const editDiam = ref(80);
const editInnerDiam = ref(0);   // donut/diaphragm inner Ø (mm); 0 = solid disc
// Source snapshot of the op's cut params, so the editable boxes can highlight what the user
// changed vs what was loaded.
const srcCut = reactive({ feed: 0, diam: 0, inner: 0, ppr: 1, rate: 25600 });
const near = (a: number, b: number) => Math.abs(Number(a) - Number(b)) < 1e-6;
/**
 * Surface speed and depth of cut are stored on BOTH machining_force_analysis (this capture) and
 * manufacturing_operations (the operation record), and they describe the same physical quantity,
 * so they should always agree. When they do, printing the capture's copy under "Cut parameters"
 * just restates a number the operation record already shows a few rows above, editable -- which
 * reads as the same field twice. Worth showing only when it carries information: the operation
 * record has no value (so this is the only source), or the two disagree (which is a data problem
 * worth seeing rather than hiding).
 */
function addsInfoOverOp(captureVal: unknown, opVal: number | null | undefined): boolean {
	// numOrNull, not Number(): Number(null) is 0, which would flag an unrecorded value as a mismatch.
	const c = numOrNull(captureVal);
	if (c == null || !Number.isFinite(c)) return false;
	const o = numOrNull(opVal);
	if (o == null || !Number.isFinite(o)) return true;
	return !near(c, o);
}
// v-model.number leaves a cleared numeric input as '' (Vue's looseToNumber falls back to the raw
// string when parseFloat('') is NaN) rather than coercing it to null — normalize that (and any
// other non-numeric junk) to null so "unset" and "explicitly 0" stay distinguishable, matching
// how the text-field patches below already send `value || null`.
function numOrNull(v: unknown): number | null {
	if (v === '' || v == null) return null;
	const n = Number(v);
	return Number.isNaN(n) ? null : n;
}
// Dirty/patch/summary comparator for the nullable numeric metadata fields (Sequence, Surface
// speed, Feed, Depth of cut): null must never compare equal to 0 (a real, unset value vs. an
// explicitly recorded zero), but two present numbers still want float tolerance, not `!==`.
function numDiffers(a: number | null, b: number | null): boolean {
	if (a == null || b == null) return a !== b;
	return !near(a, b);
}
function seedCutFromDetail() {
	const d = detail.value; if (!d) return;
	srcCut.feed = Number(d.feed) || 0;
	srcCut.diam = Number(d.outer_diameter) || Number(d.cut_diameter) || 0;
	srcCut.inner = Number(d.inner_diameter) || 0;
	srcCut.ppr = Number(d.pulses_per_rev) || 1;
	srcCut.rate = Number(d.sample_rate) || 25600;
	if (srcCut.feed) editFeed.value = srcCut.feed;
	if (srcCut.diam) editDiam.value = srcCut.diam;
	editInnerDiam.value = srcCut.inner;
	editPpr.value = srcCut.ppr;
	editRate.value = srcCut.rate;
}
// The capture box edits the rate in kHz (Hz under the hood, driving the time-scale model).
const editRateKHz = computed({
	get: () => Math.round((editRate.value / 1000) * 100) / 100,
	set: (v: number) => { editRate.value = Math.max(1, Math.round(Number(v) * 1000)); },
});
watch(() => detail.value?.id, () => { cropTouched.value = false; nextTick(() => { seedCutFromDetail(); seedMetaFromDetail(); }); });
const speedMode = ref<SpeedMode>('measured');
const editRpm = ref(1000);
const editVc = ref(100);
const editRate = ref(25600);
const editPpr = ref(1);
let cacheFs = 25600;                              // the cache's own Fs, for the Rate time-scale
// Display options (client-side).
const plotStride = ref(1);
const gridding = ref(false);
const gridN = ref(400);
const pointSize = ref(1.4);
// Tier-2 host render request.
const renderPoints = ref(5000000);   // full-res cut-window cache (host caps ~5M; >5M -> octree)
// Auto-route threshold = the crawler's live_cache_points setting (fetched on mount): a
// map with more points than the cache can hold is streamed as an octree instead. Falls
// back to 5M if the setting can't be read.
const octreeThreshold = ref(5_000_000);
const octreeMinNodePx = ref(1);
const octreeBudgetCap = ref(25_000_000);
const rendering = ref(false);
const renderMsg = ref<string | null>(null);
// ---- Full-resolution octree (Phase 2) ----------------------------------------------
// For ops too large for the client cache, the host builds a Potree octree from the raw
// .mat; the browser LOD-streams it (FrmOctree). octreeMode swaps the FRM column to it.
const gridFull = ref(false);   // "Gridded" sub-toggle, shown only in Full mode
const buildingOctree = ref(false);
const octreeMsg = ref<string | null>(null);
// Z-series: drive the octree's Z axis from a force series for a true 3D view.
const zSeries = ref<ViewZSeries>('none');
const zScale = ref(0.35);
const octreeAvailable = computed(() => detail.value?.octree_status === 'done' && !!detail.value?.octree_path);
const octreeOn = computed(() => frmMode.value === 'full' && octreeAvailable.value);
// Every long host poll below (octree, grid, bake, clear-bake, full-res render) runs under this
// guard. A poll belongs to the op that started it: it stops, and writes nothing, once another op
// is open or the dashboard unmounts. cancelAll() is called from the op-change watcher and on
// unmount, which also reset the busy flags and status messages the stopped polls would otherwise
// leave behind. Leaving the page (#24 keep-alive deactivate) does NOT stop them: the dashboard's
// state survives, so a bake started before a visit to the Record page is applied when it finishes.
// Only what needs the GL viewers (the figure reload, switching to Full) waits in `activation`
// until the page is back.
const opGuard = createOpGuard(() => detail.value?.id);
const activation = createActivationQueue();
function stopHostPolls() {
	opGuard.cancelAll();
	buildingOctree.value = false; octreeMsg.value = null;
	baking.value = false;
	rendering.value = false; renderMsg.value = null;
	statsBusy.value = false;
}
async function buildOctree() {
	const d = detail.value;
	if (!d?.id || buildingOctree.value) return;
	const live = opGuard.begin(d.id);
	buildingOctree.value = true; octreeMsg.value = 'Requesting full-res octree build on the host…';
	try {
		await api.patch(`/items/machining_force_analysis/${d.id}`, { octree_status: 'pending', octree_requested_at: new Date().toISOString() });
		if (!live()) return;
		octreeMsg.value = 'Building on the host (minutes for large ops)…';
		const deadline = Date.now() + 15 * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3000));
			if (!live()) return;
			const res = await api.get(`/items/machining_force_analysis/${d.id}`, { params: { fields: ['octree_status', 'octree_path', 'octree_points', 'octree_error'] } });
			if (!live()) return;
			const row = res.data?.data;
			if (row?.octree_status === 'done' && row.octree_path) {
				detail.value = { ...detail.value, octree_status: 'done', octree_path: row.octree_path, octree_points: row.octree_points };
				octreeMsg.value = null;
				activation.whenActive(() => { if (live()) chooseMode('full'); });   // mounts FrmOctree: not while deactivated
				return;
			}
			if (row?.octree_status === 'error') { octreeMsg.value = `Build failed: ${row.octree_error || 'unknown'}`; return; }
		}
		octreeMsg.value = 'Still building — check back shortly (is the force orchestrator running?).';
	} catch (e: any) {
		if (!live()) return;
		octreeMsg.value = e?.response?.status === 403 ? 'Not permitted (admin only) to request a host build.' : (e?.message || 'octree request failed');
	} finally { if (live()) buildingOctree.value = false; }
}

// ---- Interpolated-grid octree (Gridded + Full-res) ---------------------------------
const gridAvailable = computed(() => detail.value?.grid_octree_status === 'done' && !!detail.value?.grid_octree_path);
// "Gridded" is a single mode-aware flag: in Live it drives client-side gridCloud binning
// (the old `gridding`); in Full-res it selects the interpolated-grid octree.
const gridActive = computed(() => frmMode.value === 'full' && gridFull.value && gridAvailable.value);
const gridFidelityPct = computed(() => {
	const f = detail.value?.grid_fidelity;
	return (f == null || Number.isNaN(Number(f))) ? null : Math.round(Number(f) * 100);
});
async function buildGridOctree() {
	const d = detail.value;
	if (!d?.id || buildingOctree.value) return;
	const live = opGuard.begin(d.id);
	buildingOctree.value = true; octreeMsg.value = 'Requesting interpolated-grid build on the host…';
	try {
		await api.patch(`/items/machining_force_analysis/${d.id}`, { grid_octree_status: 'pending', grid_octree_requested_at: new Date().toISOString() });
		if (!live()) return;
		octreeMsg.value = 'Interpolating grid on the host (minutes for large ops)…';
		const deadline = Date.now() + 15 * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3000));
			if (!live()) return;
			const res = await api.get(`/items/machining_force_analysis/${d.id}`, { params: { fields: ['grid_octree_status', 'grid_octree_path', 'grid_octree_points', 'grid_octree_error', 'grid_fidelity', 'grid_arm_ratio', 'grid_cell_mm'] } });
			if (!live()) return;
			const row = res.data?.data;
			if (row?.grid_octree_status === 'done' && row.grid_octree_path) {
				detail.value = { ...detail.value, grid_octree_status: 'done', grid_octree_path: row.grid_octree_path,
					grid_octree_points: row.grid_octree_points, grid_fidelity: row.grid_fidelity,
					grid_arm_ratio: row.grid_arm_ratio, grid_cell_mm: row.grid_cell_mm };
				octreeMsg.value = null; return;
			}
			if (row?.grid_octree_status === 'error') { octreeMsg.value = `Grid build failed: ${row.grid_octree_error || 'unknown'}`; return; }
		}
		octreeMsg.value = 'Still building — check back shortly (is the force orchestrator running?).';
	} catch (e: any) {
		if (!live()) return;
		octreeMsg.value = e?.response?.status === 403 ? 'Not permitted (admin only) to request a host build.' : (e?.message || 'grid request failed');
	} finally { if (live()) buildingOctree.value = false; }
}
// When the user turns on Gridded in Full-res and no grid octree exists yet, build it.
watch(() => [gridFull.value, frmMode.value], () => {
	if (gridFull.value && frmMode.value === 'full' && !gridAvailable.value && !buildingOctree.value) buildGridOctree();
});

// The Diagnostics Workbench is deliberately NOT a panel here. It lives in the standalone force
// app as its own window/route (apps/force-app/web/src/force/DiagnosticsPage.vue) rather than in
// this generalised viewer: it is a specialist analysis surface under active development, and
// carrying a half-built one inside the everyday plotting dashboard degraded the dashboard for
// every user who was not doing diagnostics. Its request/poll build trigger moved there with it.
// Server-side computation is unchanged -- scripts/diag + process_diag_row still bake every
// statistic into the D1AN file and the diag octree.

// Displayed-vs-full resolution readout. "Full" = the map's native resolution (the octree
// total when built, else the cut-window sample count); "displayed" = what the active
// viewer renders right now (the Live rebuild count, or the octree's LOD-visible count).
const displayedPoints = ref(0);
const fullResPoints = computed<number | null>(() => {
	const d = detail.value; if (!d) return null;
	if (d.octree_points) return Number(d.octree_points);
	if (d.cut_start_idx != null && d.cut_end_idx != null) return Math.max(0, d.cut_end_idx - d.cut_start_idx);
	return null;
});
const resolutionPct = computed(() => {
	const f = fullResPoints.value;
	if (!f || !displayedPoints.value) return null;
	return Math.min(100, Math.round((displayedPoints.value / f) * 100));
});
function fmtPts(n: number | null): string {
	if (n == null) return '—';
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
	return String(n);
}
// Auto-route: when a map exceeds the octree threshold AND its octree is already built,
// default to the LOD octree view. We deliberately do NOT auto-trigger a host build here —
// that needs the daemon and takes minutes, and its progress message was leaking over the
// live cloud. Building is an explicit action (the Full-res button). Smaller maps, or large
// ones without an octree yet, stay on the Live/PNG path.
function pickDefaultMode(): FrmMode {
	return pickMode({
		preferred: preferredMode.value, octreeAvailable: octreeAvailable.value, liveAvailable: liveAvailable.value,
		fullResPoints: fullResPoints.value, octreeThreshold: octreeThreshold.value, fast: fastConnection(),
	});
}
watch(() => detail.value?.id, (id) => {
	// No op on screen (a different sample was clicked): there is nothing to adapt the mode to, and
	// re-picking now would drop Lite to Figure for want of a live cache -- then the next op arrives
	// and the layout reflows twice (#94). Wait for the next op.
	if (!id) return;
	displayedPoints.value = 0;
	octreeMsg.value = null;   // clear any stale build message from the previous op
	// Reset the Live crop handles to the new op's crop immediately (else the previous op's crop
	// lines linger until its live cache reloads). A saved override wins over the derived auto-crop;
	// onCloudLoaded then refines from the cache (but only when there's no override to respect).
	cropSavePrompt.value = false; cropSavedMsg.value = '';
	pendingCrop.clear();   // a link's crop request belongs to the op it named
	const initCrop = savedCropSec.value || cropWindow.value;
	if (initCrop) { cropStartSec.value = initCrop.start; cropEndSec.value = initCrop.end; }
	else { cropStartSec.value = 0; cropEndSec.value = 0; }
	gridFull.value = false;
	frmMode.value = pickDefaultMode();
});
// Persist the inner diameter to the op (debounced) so a reprocess / octree build picks it up
// (the orchestrator threads inner_diameter into MATLAB). Live reflects it instantly client-side.
let innerPatchTimer = 0;
watch(editInnerDiam, (v) => {
	const d = detail.value; if (!d?.id) return;
	if (Number(v) === Number(d.inner_diameter || 0)) return;
	clearTimeout(innerPatchTimer);
	innerPatchTimer = window.setTimeout(async () => {
		try { await api.patch(`/items/machining_force_analysis/${d.id}`, { inner_diameter: Number(v) || 0 }); d.inner_diameter = Number(v) || 0; } catch { /* ignore */ }
	}, 600);
});

// Same for the outer diameter: persist edits as an override so host rebuilds use them
// (the .mat metadata CutDiameter is sometimes wrong). Editing back to the metadata value
// clears the override (NULL = follow metadata again). Seeding on load is guarded out.
let outerPatchTimer = 0;
watch(editDiam, (v) => {
	const d = detail.value; if (!d?.id) return;
	const nv = Number(v) || 0;
	const cur = Number(d.outer_diameter || 0);
	const meta = Number(d.cut_diameter || 0);
	if (nv === cur) return;                                       // unchanged vs stored override
	if (cur === 0 && (nv === 0 || Math.abs(nv - meta) < 1e-6)) return;   // just the metadata seed
	clearTimeout(outerPatchTimer);
	outerPatchTimer = window.setTimeout(async () => {
		const store = Math.abs(nv - meta) < 1e-6 ? null : nv;      // back-to-metadata clears it
		try { await api.patch(`/items/machining_force_analysis/${d.id}`, { outer_diameter: store }); d.outer_diameter = store; } catch { /* ignore */ }
	}, 600);
});

// ---- Signal statistics panel (collapsed by default) --------------------------------
// Post-mortem stats computed client-side from the live cache: mean/RMS/min/max between
// the crop lines per axis, plus whole-signal effective bit depth and rail/clip analysis
// (over-range detection). Reuses the FrmCloud LRU so Lite mode costs nothing extra; if
// the cache isn't downloaded yet the panel offers an explicit compute (= download).
// One accordion open at a time in the detail column: Operation detail | Signal statistics
// | Signal filters are mutually exclusive (opening one folds the others).
type DetailPanel = 'detail' | 'display' | 'stats' | 'cutting' | 'filters';
const openPanel = ref<DetailPanel | null>('detail');
function togglePanel(p: DetailPanel) { openPanel.value = openPanel.value === p ? null : p; }
const opDetailOpen = computed(() => openPanel.value === 'detail');
const displayPanelOpen = computed(() => openPanel.value === 'display');
const statsOpen = computed(() => openPanel.value === 'stats');
const cuttingOpen = computed(() => openPanel.value === 'cutting');
const STAT_AXES = ['Fx', 'Fy', 'Fz'] as const;
const sigStats = ref<SignalStats | null>(null);
const statsBusy = ref(false);
const statsErr = ref<string | null>(null);
const statsCacheMb = computed(() => {
	const d = detail.value; if (!d?.cut_start_idx || !d?.cut_end_idx) return null;
	const pts = Math.min(d.cut_end_idx - d.cut_start_idx, octreeThreshold.value);
	return Math.round((pts * 24) / 1e6);   // 6 float32 arrays per sample
});
async function computeStats() {
	const d = detail.value;
	if (!d?.live_cache_file || statsBusy.value) return;
	// The cache download can take a while: if the operator opens another op (or leaves the page)
	// meanwhile, this result belongs to the old op and must not land in the new op's panel.
	const live = opGuard.begin(d.id);
	statsBusy.value = true; statsErr.value = null;
	try {
		let c = cacheGet(d.live_cache_file);
		if (!c) {
			const res = await api.get(`/assets/${d.live_cache_file}`, { responseType: 'arraybuffer' });
			c = parseCache(res.data as ArrayBuffer);
			cachePut(d.live_cache_file, c);
		}
		if (!live()) return;
		const [cs, ce] = resolveStatsWindow(cropStartSec.value, cropEndSec.value, c);
		sigStats.value = computeSignalStats(c, cs, ce);
	} catch (e: any) {
		if (!live()) return;
		statsErr.value = e?.message || 'failed to compute statistics';
	} finally { if (live()) statsBusy.value = false; }
}
// Recompute (cheap, cache already local) when the crop moves while the panel is open.
let statsTimer = 0;
watch(() => [cropStartSec.value, cropEndSec.value], () => {
	if ((!statsOpen.value && !cuttingOpen.value) || !sigStats.value) return;
	clearTimeout(statsTimer);
	statsTimer = window.setTimeout(computeStats, 400);
});
watch(() => detail.value?.id, () => { sigStats.value = null; statsErr.value = null; });
// The crop handles show on the envelope charts in every mode, but the crop only affects the
// Lite recompute (Figure is a static PNG; Full is a baked octree). So the moment the user drags
// a handle, jump to Lite so they see the effect — provided this op has a live cache.
function onCropEdit(which: 'start' | 'end', v: number) {
	if (which === 'start') cropStartSec.value = v; else cropEndSec.value = v;
	cropTouched.value = true;
	pendingCrop.clear();   // the user's own edit beats a link's crop request
	if (frmMode.value !== 'lite' && liveAvailable.value) chooseMode('lite');
}
watch(statsOpen, (open) => {
	// auto-compute on first open when the cache is already local (e.g. Lite was on)
	if (open && !sigStats.value && detail.value?.live_cache_file && cacheGet(detail.value.live_cache_file)) computeStats();
});
function fmtStat(v: number): string {
	const a = Math.abs(v);
	if (!Number.isFinite(v)) return '—';
	if (a >= 1000) return (v / 1000).toFixed(2) + 'k';
	if (a >= 10) return v.toFixed(1);
	return v.toFixed(2);
}

// ---- Cutting metrics card (cuttingMetrics.ts; spec 2026-10-06-cutting-metrics-design.md) ----
// Over the same crop window as the statistics. The standard mapping is Fc = Fx, Ff = Fy, Fp = Fz
// (the owner's), but it depends on workholding and the operation, so it is selectable and
// remembered per operation subtype in this browser (cuttingMetrics.ts).
removeLegacyAxisMap();   // the old single choice was made against the previous default
// cutSubtype, axisMapSubtype, axisMapSel and its loader are declared with the operation refs
// (below), which they read.
const onAxisMapChange = () => writeAxisMapForSubtype(axisMapSubtype.value, parseAxisMap(axisMapSel.value));
const axisMap = computed(() => parseAxisMap(axisMapSel.value));
const AXIS_MAP_STANDARD = formatAxisMap(DEFAULT_AXIS_MAP);
// Operation record first (editable above), else the capture's own copy. With no (readable) operation
// the editOp* refs still hold the previous operation's values, so they are ignored then.
const cutFeed = computed(() => (op.value ? numOrNull(editOpFeedMmPerRev.value) : null) ?? numOrNull(detail.value?.feed));
const cutAp = computed(() => (op.value ? numOrNull(editOpAxialDoc.value) : null) ?? numOrNull(detail.value?.depth_of_cut));
// Facing, grooving and parting spiral inwards: D_mid uses the same origin (the active crop start,
// the saved crop when there is one) and the same feed (the geometry feed) as the plots' radial axis.
const cutting = computed(() => {
	if (!sigStats.value) return null;
	const subtype = cutSubtype.value;
	return computeCuttingMetrics({
		stats: sigStats.value, axisMap: axisMap.value,
		opKind: opKindFromSubtype(subtype), spiral: usesSpiralDiameter(subtype),
		diameterMm: editDiam.value, feedMmPerRev: cutFeed.value, apMm: cutAp.value,
		spiralFeedMmPerRev: editFeed.value, spiralOriginSec: activeCrop.value?.start,
	});
});
const cuttingMapText = computed(() => {
	const m = axisMap.value;
	return `Axis mapping in use: Fc (tangential, main cutting) = ${m.Fc}, Ff (feed) = ${m.Ff}, Fp (passive/radial) = ${m.Fp}. The standard is ${AXIS_MAP_STANDARD}, but it depends on workholding and operation; the mounting is not recorded. Change it with the selector (remembered per operation type).`;
});
const cutVal = (m: Metric | undefined, digits = 1) => m?.value == null ? '—' : (Math.abs(m.value) >= 1000 ? (m.value / 1000).toFixed(2) + 'k' : m.value.toFixed(digits));
const cutTip = (m: Metric | undefined, formula: string) => m?.value == null ? `Unavailable: ${m?.reason ?? 'no data'}` : formula;

// CSV of the statistics table (columns in statsCsv.ts).
const STATS_COLS = statsCsvColumns(() => sigStats.value, () => cutting.value);
function statsCsv(): string {
	const st = sigStats.value;
	return st ? toCsv(STATS_COLS, STAT_AXES.map((a) => ({ axis: a, ...st.axes[a] }))) : '';
}
function downloadStatsCsv() {
	const text = statsCsv();
	if (text) downloadText(`signal_stats_${safeFilePart(opLabel.value) || 'op'}.csv`, text);
}
const { copied: statsCopied, failed: statsCopyFailed, copy: copyStatsCsv } = useCopyFeedback(statsCsv);

// ---- Signal-filter suite -----------------------------------------------------------
// Interactive: the working chain is previewed by the host filter-service on the live
// cache; raw + filtered render side-by-side in two linked viewports (compareView shared).
// Baking patches the op's filter_chain + reprocesses so ALL outputs are filtered.
const filtersOpen = computed(() => openPanel.value === 'filters');
const workChain = ref<FilterChain>(defaultChain());
const filteredCache = ref<Cache | null>(null);
// The RAW pane in compare mode plots the SAME decimated samples as the filtered pane
// (identical spiral positions; only colour differs) — the service's stride applied to the
// local full cache. Null until the first preview resolves, then the raw pane switches to it.
const rawDecimatedCache = ref<Cache | null>(null);
const filterBusy = ref(false);
const filterErr = ref<string | null>(null);
const filterSkipped = ref<string[]>([]);
const filterFftOverlay = ref<{ f: number[]; amp: number[] } | null>(null);
const baking = ref(false);
const profiles = ref<any[]>([]);
// Live needs a loaded cache; if this op has none, fall back to the static view. Declared here
// (above the filter-preview watch) so the watch's eager source `() => liveOn.value` doesn't hit a
// temporal-dead-zone ReferenceError at setup — which silently half-wired Lite reactivity.
const liveAvailable = computed(() => !!detail.value?.live_cache_file);
const liveOn = computed(() => frmMode.value === 'lite' && liveAvailable.value);
const compareOn = computed(() => liveOn.value && chainActive(workChain.value) && filtersOpen.value);
// Both live panes share ONE view object so pan/zoom in either drives both.
const compareView = reactive({ cx: 0, cy: 0, span: 1, active: false });
// Geometry/display props every Lite FrmCloud pane shares; each pane adds its own cache override,
// colour scale and events. Evaluated at render time, so the refs declared further down are set.
const cloudProps = computed(() => ({
	cacheFileId: detail.value?.live_cache_file, axis: axis.value,
	feed: editFeed.value, diam: editDiam.value, innerDiam: editInnerDiam.value, speedMode: speedMode.value,
	rpm: editRpm.value, vc: editVc.value, timeScale: timeScale.value, ppr: editPpr.value,
	cropStartSec: cropStartSec.value, cropEndSec: cropEndSec.value,
	stride: plotStride.value, gridding: gridding.value, gridN: gridN.value, pointSize: pointSize.value,
}));
function mergeChain(raw: any): FilterChain {
	const d = defaultChain();
	if (!raw) return d;
	// deep-merge each stage over the defaults so chains saved before a stage existed
	// (e.g. pre-highpass) don't leave undefined stages that crash the template.
	return {
		despike: { ...d.despike, ...(raw.despike || {}) },
		detrend: { ...d.detrend, ...(raw.detrend || {}) },
		highpass: { ...d.highpass, ...(raw.highpass || {}) },
		lowpass: { ...d.lowpass, ...(raw.lowpass || {}) },
		notch: { ...d.notch, ...(raw.notch || {}) },
	};
}
// savedChain = the op's persisted filter_chain (from the DB), regardless of how it was applied.
// filterBaked = every derived output has been reprocessed with it (heavy bake); otherwise it's a
// LIGHT apply — the chain is the op's default but only Lite recomputes it live (Full/PNG stay raw).
const savedChain = computed<FilterChain | null>(() => {
	const fc = detail.value?.filter_chain;
	if (!fc) return null;
	return mergeChain(typeof fc === 'string' ? JSON.parse(fc) : fc);
});
const filterBaked = computed(() => detail.value?.filter_baked === true);
const bakedChain = computed<FilterChain | null>(() => (filterBaked.value ? savedChain.value : null));
const appliedLight = computed<boolean>(() => !!savedChain.value && !filterBaked.value);
// The single filtered pane: a light-applied op renders one Lite cloud recomputed from filteredCache
// (the compare panes only appear while the Filters panel is open for tuning). Baked ops need no solo
// pane — their loaded cache is already filtered, so the normal Lite pane shows the filtered signal.
const filteredSoloOn = computed(() => liveOn.value && !filtersOpen.value && appliedLight.value && filteredCache.value != null);

async function loadProfiles() {
	try { profiles.value = (await api.get('/items/filter_profiles', { params: { fields: ['id', 'name', 'chain'], sort: 'name', limit: 100 } })).data.data ?? []; }
	catch { profiles.value = []; }
}
// Which chain the Lite filtered preview reflects: the editable workChain while the Filters panel is
// open (live tuning + raw|filtered compare), else the op's saved chain when it's light-applied (the
// single filtered pane persists after leaving the panel). Null => nothing to preview.
function previewChain(): FilterChain | null {
	if (filtersOpen.value) return workChain.value;
	if (appliedLight.value && liveOn.value) return savedChain.value;
	return null;
}
let previewAbort: AbortController | null = null;
async function runPreview() {
	const d = detail.value;
	previewAbort?.abort();                     // cancel any in-flight preview (stale-result guard)
	const chain = previewChain();
	if (!d?.live_cache_file || !chain || !chainActive(chain)) { filteredCache.value = null; rawDecimatedCache.value = null; filterFftOverlay.value = null; filterBusy.value = false; return; }
	const ac = new AbortController(); previewAbort = ac;
	filterBusy.value = true; filterErr.value = null;
	try {
		// Independent requests to the filter service, so both start now. The FFT overlay is an
		// optional extra: its failure costs only the overlay, never the filtered cloud.
		const fftReq = chartMode.value === 'fft' ? fetchFilteredFft(d.live_cache_file, chain, axis.value, ac.signal) : null;
		fftReq?.catch(() => {});   // awaited (and reported) below; never an unhandled rejection
		const { cache, skipped, stride } = await fetchFiltered(d.live_cache_file, chain, 1_500_000, ac.signal);
		if (ac.signal.aborted) return;
		filteredCache.value = cache; filterSkipped.value = skipped;
		// Decimate the local full cache by the SAME stride so the raw pane plots the identical
		// samples (honest side-by-side: same geometry, filtered only changes the colour).
		const full = cacheGet(d.live_cache_file);
		rawDecimatedCache.value = full ? decimateCache(full, stride) : null;
		if (fftReq) {
			try {
				const overlay = await fftReq;
				if (!ac.signal.aborted) filterFftOverlay.value = overlay;
			} catch (e: any) {
				if (e?.name === 'AbortError' || ac.signal.aborted) return;
				filterFftOverlay.value = null;
				filterErr.value = `filtered FFT unavailable — ${e?.message || 'request failed'}`;
			}
		}
	} catch (e: any) {
		if (e?.name === 'AbortError' || ac.signal.aborted) return;   // superseded — not an error
		filterErr.value = (e?.message || 'filter service unreachable').includes('Failed to fetch')
			? 'filter service unreachable — raw only' : e?.message;
		filteredCache.value = null;
		ac.abort();   // drop a still-running FFT request for this failed preview
	} finally { if (previewAbort === ac) filterBusy.value = false; }
}
let previewTimer = 0;
watch([workChain, () => detail.value?.live_cache_file, () => filtersOpen.value, () => appliedLight.value, () => liveOn.value, axis, chartMode], () => {
	// Preview whenever we're tuning (panel open) OR the op is light-applied and Lite is showing it.
	if (!filtersOpen.value && !(appliedLight.value && liveOn.value)) {
		if (!compareOn.value) filteredCache.value = null;   // drop the stale filtered cloud
		return;
	}
	clearTimeout(previewTimer);
	previewTimer = window.setTimeout(runPreview, 400);
}, { deep: true });
watch(() => detail.value?.id, () => {
	stopHostPolls();   // a poll started for the previous op must not report into this one
	workChain.value = savedChain.value ?? defaultChain();
	filteredCache.value = null; filterErr.value = null; filterFftOverlay.value = null;
});
function applyProfile(id: string) {
	const p = profiles.value.find((x) => x.id === id);
	if (p?.chain) workChain.value = mergeChain(typeof p.chain === 'string' ? JSON.parse(p.chain) : p.chain);
}
async function saveProfile() {
	const name = window.prompt('Save filter profile as:'); if (!name) return;
	try { await api.post('/items/filter_profiles', { name, chain: workChain.value }); await loadProfiles(); }
	catch (e: any) { filterErr.value = e?.response?.data?.errors?.[0]?.message || 'save failed (name taken?)'; }
}
// Light apply: save the chain as the op's default WITHOUT reprocessing. Lite recomputes it live
// (single filtered pane persists once the Filters panel closes); Full octree & FRM PNGs stay raw
// until an explicit Bake (or the crawler rebuilds). No host daemon needed, not admin-gated.
async function applyFilter() {
	const d = detail.value;
	if (!d?.id || !chainActive(workChain.value)) return;
	const chain = JSON.parse(JSON.stringify(workChain.value));
	filterErr.value = null;
	detail.value = { ...detail.value, filter_chain: chain, filter_baked: false };   // optimistic — solo pane shows now
	try { await api.patch(`/items/machining_force_analysis/${d.id}`, { filter_chain: chain, filter_baked: false }); }
	catch (e: any) { filterErr.value = e?.response?.status === 403 ? 'Not permitted to save this filter.' : (e?.message || 'save failed'); }
	openPanel.value = null;   // close the Filters panel → collapse compare down to the single filtered pane
}
async function bakeFilters() {
	const d = detail.value;
	if (!d?.id || baking.value) return;
	const live = opGuard.begin(d.id);
	baking.value = true; filterErr.value = null;
	try {
		await api.patch(`/items/machining_force_analysis/${d.id}`, { filter_chain: workChain.value, status: 'pending' });
		const deadline = Date.now() + 15 * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3000));
			if (!live()) return;
			const row = (await api.get(`/items/machining_force_analysis/${d.id}`, { params: { fields: ['status', 'filter_chain', 'live_cache_file', 'error_message'] } })).data?.data;
			if (!live()) return;
			if (row?.status === 'done') {
				await api.patch(`/items/machining_force_analysis/${d.id}`, { filter_baked: true }).catch(() => {});   // outputs now reprocessed
				// The bake is on the server either way; only the open op's view is updated.
				if (!live()) return;
				detail.value = { ...detail.value, filter_chain: row.filter_chain, filter_baked: true, live_cache_file: row.live_cache_file };
				cachePut(row.live_cache_file, null as any); await loadFrm(); return;
			}
			if (row?.status === 'error') { filterErr.value = `Bake failed: ${row.error_message || 'unknown'}`; return; }
		}
		filterErr.value = 'Still baking — check back shortly (is the force orchestrator running?).';
	} catch (e: any) {
		if (!live()) return;
		filterErr.value = e?.response?.status === 403 ? 'Not permitted (admin only) to bake.' : (e?.message || 'bake request failed');
	}
	finally { if (live()) baking.value = false; }
}
// Clear routes by state: a light apply just drops the saved chain (no host); a bake must reprocess
// the outputs back to raw (status='pending', admin-only), so it keeps the polling path.
async function clearFilter() {
	const d = detail.value; if (!d?.id) return;
	if (!filterBaked.value) {
		workChain.value = defaultChain();
		filteredCache.value = null;
		detail.value = { ...detail.value, filter_chain: null, filter_baked: false };
		await api.patch(`/items/machining_force_analysis/${d.id}`, { filter_chain: null, filter_baked: false }).catch(() => {});
		return;
	}
	await clearBake();
}
async function clearBake() {
	const d = detail.value; if (!d?.id) return;
	const live = opGuard.begin(d.id);
	workChain.value = defaultChain();
	await api.patch(`/items/machining_force_analysis/${d.id}`, { filter_chain: null, filter_baked: false, status: 'pending' }).catch(() => {});
	if (!live()) return;
	baking.value = true;
	try {
		const deadline = Date.now() + 15 * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3000));
			if (!live()) return;
			const row = (await api.get(`/items/machining_force_analysis/${d.id}`, { params: { fields: ['status', 'live_cache_file'] } })).data?.data;
			if (!live()) return;
			if (row?.status === 'done') { detail.value = { ...detail.value, filter_chain: null, filter_baked: false, live_cache_file: row.live_cache_file }; cachePut(row.live_cache_file, null as any); await loadFrm(); return; }
			if (row?.status === 'error') return;
		}
	} finally { if (live()) baking.value = false; }
}
// Full ColorScale editor (Stage 5/6): `colorScale` is now the real source of truth for every
// FRM pane on this dashboard, driven by ColorScaleEditor.vue's update:colorScale. `locked`
// replaces the old `cauto` checkbox -- unlocked (false) tracks whatever climits last reported
// (auto), locked (true) freezes satMin/satMax at their current values regardless of new climits.
// autoClimits mirrors what the cloud actually reports, purely to give the editor's histogram
// strip a sensible domain (the full auto-detected range) independent of the user-narrowed
// saturation window -- it no longer feeds colorScale directly the way the old cauto path did.
// cacheGet() reads a plain (non-reactive) Map — a computed calling it would never re-run once
// the cache lands after a later on-demand fetch. Bump this whenever the cache changes and read
// it (even unused) wherever radialValuesFor() or the colour-scale histogram below might depend on
// a just-arrived cache. Declared up here (it used to live down by radialValuesFor) so the
// colour-scale computeds that read it are safe to evaluate eagerly -- an `immediate` watcher on
// one of them would otherwise hit this in the temporal dead zone.
const cacheEpoch = ref(0);
// Unlocking re-applies the renderer's range, or the cache-derived one when none has reported.
const { colorScale, locked, autoClimits, onClimits, seed: seedAuto } =
	useAutoColorScale({ fallback: () => cacheAutoLimits.value });
// Histogram of what a mounted FrmCloud actually renders (e.g. the filtered data of a light-applied
// chain); preferred over re-binning the raw cache.
const rendererHistogram = ref<Histogram | null>(null);
// Stale ranges from the previous operation/channel must not outlive it: the cache-derived fallback
// below is only consulted while no renderer has reported for the current data. The displayed range
// is in absolute units of the old data, so it reopens too.
watch([() => detail.value?.id, axis], () => {
	autoClimits.value = null; rendererHistogram.value = null;
	colorScale.value = withOpenDisplay(colorScale.value);
});
// Compare mode's filtered pane scales to its own data (a high-pass shifts the whole range) unless
// the user locked the scale, in which case both panes share it.
const filteredAuto = ref<{ cmin: number; cmax: number } | null>(null);
watch(filteredCache, () => { filteredAuto.value = null; });
const filteredColorScale = computed<ColorScale>(() => {
	const s = colorScale.value, a = filteredAuto.value;
	return locked.value || !a ? s : withAutoRange(s, a.cmin, a.cmax);
});
// Derived straight from the resident cache rather than from a renderer's @climits/@histogram
// events. Those only arrive when a FrmCloud is actually mounted -- not in Figure mode, not when
// the FRM panel is closed, and never from FrmOctree (Full mode streams an octree with no flat
// scalar array to bin). The Display accordion holding the editor is independent of all of that,
// so it was showing an empty strip and, with no climits, an x-axis that fell back to the scale's
// own range and zoomed as you dragged it. Reading the cache directly makes the editor
// self-sufficient; the always-on radial axis already guarantees the cache gets fetched.
const cacheAutoLimits = computed<[number, number] | null>(() => {
	void cacheEpoch.value;
	const d = detail.value;
	const c = d?.live_cache_file ? cacheGet(d.live_cache_file) : null;
	return c ? axisAutoLimits(c, axis.value) : null;
});
// The auto range currently in force: a renderer's report wins, else the cache-derived fallback.
// Short-circuits, so the cache scan only runs when no renderer has reported.
const currentAuto = computed<[number, number] | null>(() =>
	autoClimits.value ? [autoClimits.value.cmin, autoClimits.value.cmax] : cacheAutoLimits.value);
// Never the scale's own range as a fallback: that moves as a handle is dragged and the editor's
// axis re-zoomed under it after each release (#78). 0..1 is defaultScale's own range.
const colorDomainLo = computed(() => currentAuto.value?.[0] ?? 0);
const colorDomainHi = computed(() => currentAuto.value?.[1] ?? 1);
// Binned over the AUTO range, not the edited one, so dragging a handle never triggers an O(N)
// re-bin (and the curve stays put under the moving handles).
// Seed the scale from the cache whenever no renderer has reported climits -- Figure mode, a
// closed FRM panel, or Full/octree mode all leave satMin/satMax sitting at defaultScale's [0, 1]
// while the strip's axis shows the real data range. On a cut whose forces are fractions of a
// newton that puts the entire ramp off the end of the axis, so the curve renders with no colour
// band at all and every handle sits in the wrong place.
// Source short-circuits on autoClimits so the O(N log N) cache scan only runs when no renderer
// has reported for the current data.
watch(() => (autoClimits.value ? null : cacheAutoLimits.value), (range) => {
	if (!range || locked.value) return;
	const [lo, hi] = range;
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
	seedAuto(lo, hi);
}, { immediate: true });
const colorHistogram = computed<Histogram | null>(() => {
	if (rendererHistogram.value) return rendererHistogram.value;
	void cacheEpoch.value;
	const d = detail.value;
	const c = d?.live_cache_file ? cacheGet(d.live_cache_file) : null;
	const arr = c ? (c as any)[axis.value] as Float32Array | undefined : undefined;
	const range = cacheAutoLimits.value;
	if (!arr?.length || !range) return null;
	return histogramFrom(arr, arr.length, range[0], range[1], 64);
});
// Filtering shifts the force range (e.g. a high-pass strips the DC offset), so any manually
// locked colour limits become meaningless — auto-unlock so both panes recompute their own
// scale over the (raw / filtered) data.
watch(() => chainActive(workChain.value), (active) => { if (active) locked.value = false; });
// In-place collapses to free space when live.
const sampleDetailOpen = ref(true);
const colStackHidden = ref(false);               // hide the Samples/Operations column
const detailHidden = ref(false);                 // hide the Sample/Operation detail column
const frmUrl = ref<string | null>(null);
const frmLoading = ref(false);
// What the active view type (Figure / Lite / Full) is busy with, for the busy mark on its segment
// button (#102). Lite/Full report through @stage; the Figure download is tracked here.
const frmStage = ref<StageInfo | null>(null);
const figStage = ref<LoadStage | null>(null);
// The figure download only counts in Figure mode: Lite/Full report through frmStage.
const frmBusy = computed(() => !!frmStage.value || (frmMode.value === 'figure' && frmLoading.value));
// A renderer that unmounts mid-load (the view type changed) never reports idle: reset on a switch;
// the one that replaces it reports its own stage.
watch([frmMode, liveOn, octreeOn, compareOn, filteredSoloOn], () => { frmStage.value = null; });
const frmCache = new Map<string, string>();

// ---------------------------------------------------------------- layout state
// Column widths are user-resizable (drag handles); persisted per browser so the layout survives a
// reload. Keys from the old split layout (rightSplit/showForce/showFRM/visAxes) are ignored.
const LAYOUT_KEY = 'd1-force-dashboard-layout-v1';
const colA = ref(240);          // Samples/Operations column width (px)
const colB = ref(300);          // Sample/Operation detail column width (px)
const dragging = ref(false);

(function loadLayout() {
	try {
		const raw = localStorage.getItem(LAYOUT_KEY);
		if (!raw) return;
		const v = JSON.parse(raw);
		if (typeof v.colA === 'number') colA.value = v.colA;
		if (typeof v.colB === 'number') colB.value = v.colB;
		if (typeof v.colStackHidden === 'boolean') colStackHidden.value = v.colStackHidden;
		if (typeof v.detailHidden === 'boolean') detailHidden.value = v.detailHidden;
		if (v.frmMode === 'figure' || v.frmMode === 'lite' || v.frmMode === 'full') chooseMode(v.frmMode);
	} catch { /* ignore malformed/absent saved layout */ }
})();
watch([colA, colB, colStackHidden, detailHidden, frmMode], () => {
	localStorage.setItem(LAYOUT_KEY, JSON.stringify({
		colA: colA.value, colB: colB.value,
		colStackHidden: colStackHidden.value, detailHidden: detailHidden.value,
		// Persist Live so returning to the dashboard keeps the interactive FRM cloud
		// instead of silently dropping back to the static PNG. (liveOn still requires a
		// live cache on the selected op, so ops without one safely show the PNG.)
		frmMode: frmMode.value,
	}));
});

function dragAxis(getStart: () => number, apply: (v: number) => void, min: number, max: number) {
	return (ev: PointerEvent) => {
		ev.preventDefault();
		const startX = ev.clientX;
		const start = getStart();
		dragging.value = true;
		function onMove(e: PointerEvent) { apply(Math.min(max, Math.max(min, start + (e.clientX - startX)))); }
		function onUp() {
			dragging.value = false;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	};
}
const startColAResize = dragAxis(() => colA.value, (v) => { colA.value = v; }, 170, 380);
const startColBResize = dragAxis(() => colB.value, (v) => { colB.value = v; }, 220, 460);

const rightAreaEl = ref<HTMLElement | null>(null);

// Below this content width, fixed pixel columns would overflow — stack instead.
// Tracks the real element (Directus reserves side chrome, so the viewport is
// not a reliable proxy).
const layoutEl = ref<HTMLElement | null>(null);
const layoutW = ref(1400);
const stacked = computed(() => layoutW.value < 860);
const gridCols = computed(() => {
	if (stacked.value) return '1fr';
	// COL1 (samples/operations) and COL2 (sample/operation detail) can each be
	// folded away to the left to hand the right area more room. Track list is built
	// positionally to match exactly which columns (+ their resizers) are rendered.
	const parts: string[] = [];
	if (!colStackHidden.value) parts.push(`${colA.value}px`, '6px');
	if (!detailHidden.value) parts.push(`${colB.value}px`, '6px');
	parts.push('1fr');
	return parts.join(' ');
});

// Fit the whole module into the viewport height (no page scroll) on any screen,
// including 16:9 desktops — measured, not guessed, since Directus's own chrome
// height varies. Re-measured on mount + window resize; skipped when stacked
// (mobile/narrow layouts scroll naturally, like any long page).
const availableHeight = ref(700);
function updateAvailableHeight() {
	if (!layoutEl.value) return;
	const top = layoutEl.value.getBoundingClientRect().top;
	// Read .fd's real bottom padding instead of hardcoding it a second time here — a stale
	// hardcoded value (this used to say 20 while .fd's CSS padding-bottom is 40) silently leaves
	// that much extra page-level scroll on any viewport, not just small screens.
	const fd = layoutEl.value.closest('.fd') as HTMLElement | null;
	const bottomPad = fd ? parseFloat(getComputedStyle(fd).paddingBottom) || 0 : 40;
	availableHeight.value = Math.max(420, Math.floor(window.innerHeight - top - bottomPad));
}
function measureLayout() {
	if (!layoutEl.value) return;
	layoutW.value = layoutEl.value.getBoundingClientRect().width;
	updateAvailableHeight();
}
// #24: AppShell.vue keeps this component alive (<keep-alive include="StandaloneForceDashboard">)
// rather than unmounting it when navigating away -- so onMounted below only ever runs ONCE, the
// very first time the Plot page is visited in a session, never again on later visits. Deactivating
// hides the element (effectively display:none), so layoutW/availableHeight go stale at whatever
// they were the moment it was hidden; reactivating doesn't touch them until ResizeObserver's own
// (queued, not synchronous) callback eventually fires. In the gap, grid-layout-plus renders with
// the stale/default measurements -- e.g. the FRM panel claiming the Signals column's width too --
// then snaps to the correct layout a moment later once the observer catches up. onActivated forces
// an immediate remeasure instead of waiting on that.
onActivated(() => { measureLayout(); nextTick(measureLayout); activation.activate(); });
onDeactivated(() => activation.deactivate());
let layoutRO: ResizeObserver | undefined;
onMounted(() => {
	// ResizeObserver covers content reflow (panel resize, hide/show toggles);
	// a direct window 'resize' listener is a belt-and-braces fallback since RO
	// firing can be unreliable under rapid/programmatic viewport changes.
	layoutRO = new ResizeObserver(measureLayout);
	if (layoutEl.value) layoutRO.observe(layoutEl.value);
	measureLayout();
	window.addEventListener('resize', measureLayout);
});
onBeforeUnmount(() => {
	layoutRO?.disconnect();
	window.removeEventListener('resize', measureLayout);
});

// ---- Flexible plot-panel grid (Signals + FRM, add/close/rearrange) ----------
// The plot area is a grid-layout-plus grid of panels (like the recording view). The
// Samples/Operations + detail stay as the docked left rail; only the plots are flexible.
// Per-instance panel state: a Signals panel carries its own selected channels + RPM toggle so
// duplicated panels can differ (e.g. one showing only Fz next to one showing Fx/Fy).
type RPanelType = 'signals' | 'frm' | 'wear' | 'doctor';
type RPanel = { i: string; type: RPanelType; x: number; y: number; w: number; h: number; channels?: Axis[]; rpm?: boolean };
const RIGHT_KEY = 'd1-force-right-layout-v2';
const RIGHT_DEFAULT: RPanel[] = [
	{ i: 'signals', type: 'signals', x: 0, y: 0, w: 6, h: 20, channels: ['Fx', 'Fy', 'Fz'], rpm: false },
	{ i: 'frm', type: 'frm', x: 6, y: 0, w: 6, h: 20 },
];
const R_META: Record<string, { title: string; icon: string }> = {
	signals: { title: 'Signals', icon: 'insights' },
	frm: { title: 'FRM map', icon: 'fingerprint' },
	wear: { title: 'Wear trend', icon: 'trending_up' },
	doctor: { title: 'Metadata doctor', icon: 'health_and_safety' },
};
// NOTE: loadRight() validates a persisted layout with `every(p => R_META[p.type])`, so ADDING a
// type is backwards compatible and RIGHT_KEY must NOT be bumped — bumping it would throw away
// every user's saved panel arrangement to add one optional panel.
function loadRight(): RPanel[] {
	try {
		const v = JSON.parse(localStorage.getItem(RIGHT_KEY) || 'null');
		if (Array.isArray(v) && v.length && v.every((p) => p && R_META[p.type])) return v;
	} catch { /* ignore */ }
	return RIGHT_DEFAULT.map((p) => ({ ...p }));
}
const rightLayout = ref<RPanel[]>(loadRight());
// Persist debounced: the deep watch fires on every drag/resize tick, and a synchronous
// localStorage write per tick is what made dragging janky (worst in the heavier Directus shell).
let persistT: ReturnType<typeof setTimeout> | null = null;
watch(rightLayout, (v) => {
	if (persistT) clearTimeout(persistT);
	const snapshot = JSON.stringify(v);
	persistT = setTimeout(() => localStorage.setItem(RIGHT_KEY, snapshot), 250);
}, { deep: true });
// Row height so the panels fill the measured area exactly. grid-layout-plus sizes its container as
// `bottomRow * (rowHeight + marginY) + marginY`, so the exact-fit inverse is
// `(H - marginY) / bottomRow - marginY` — the previous `(H - 24) / 20` overflowed by ~186px (hidden
// only because .right-area scrolls), and its hardcoded /20 (the DEFAULT panel h) stopped being
// right the moment a user resized or added a panel. Both are derived properly now.
//
// NOT floored: grid-layout-plus renders each row's offset as `row * (rowHeight + marginY)`, a plain
// CSS pixel translate that handles a fractional rowHeight fine, so flooring it here bought nothing
// but lost up to `bottomRow` px overall (each of `bottomRow` rows independently rounds its own
// height down) — with a typical bottomRow of ~20 that is a very visible gap at the bottom of the
// Signals/FRM column versus the other columns, which stretch to the exact CSS height instead (#16).
const RIGHT_MARGIN = 10;   // must match :margin="[10, 10]" on the right-hand GridLayout
const rightBottomRow = computed(() => rightLayout.value.reduce((m, p) => Math.max(m, p.y + p.h), 0) || 1);
const rightRowH = computed(() =>
	Math.max(16, (availableHeight.value - RIGHT_MARGIN) / rightBottomRow.value - RIGHT_MARGIN),
);
const rightAddOpen = ref(false);
function addRightPanel(type: RPanelType) {
	rightAddOpen.value = false;
	// Place a new panel beside the shortest existing column when there's room on the top row,
	// otherwise start a fresh row below. Half-height (h:10) so a stacked pair fits one screen and
	// the panel lands within (or just at the edge of) view rather than a full screen down.
	const topRowW = rightLayout.value.filter((p) => p.y === 0).reduce((s, p) => s + p.w, 0);
	const maxY = rightLayout.value.reduce((m, p) => Math.max(m, p.y + p.h), 0);
	const fitsTop = topRowW <= 6;
	const base: RPanel = {
		i: `${type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
		type, x: fitsTop ? topRowW : 0, y: fitsTop ? 0 : maxY, w: 6, h: fitsTop ? 20 : 10,
	};
	if (type === 'signals') { base.channels = ['Fx', 'Fy', 'Fz']; base.rpm = false; }
	rightLayout.value = [...rightLayout.value, base];
	// Bring the freshly added panel into view (it may extend below the fold).
	nextTick(() => {
		const el = rightAreaEl.value?.querySelector(`[data-panel-id="${base.i}"]`);
		el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	});
}
function closeRightPanel(i: string) { if (rightLayout.value.length > 1) rightLayout.value = rightLayout.value.filter((p) => p.i !== i); }
function resetRightLayout() { rightLayout.value = RIGHT_DEFAULT.map((p) => ({ ...p })); }

// -------------------------------------------------------------------- data
onMounted(async () => {
	loadProfiles();
	try {
		// Auto-route threshold comes from the crawler's live_cache_points setting.
		try {
			const s = await api.get('/items/force_crawler_state', { params: { fields: ['live_cache_points', 'octree_threshold', 'octree_min_node_px', 'octree_budget_cap'], limit: 1 } });
			const row = s.data?.data?.[0] || s.data?.data;
			const cap = Number(row?.octree_threshold ?? row?.live_cache_points);
			if (Number.isFinite(cap) && cap > 0) octreeThreshold.value = cap;
			const mnp = Number(row?.octree_min_node_px);
			if (Number.isFinite(mnp) && mnp > 0) octreeMinNodePx.value = mnp;
			const bc = Number(row?.octree_budget_cap);
			if (Number.isFinite(bc) && bc > 0) octreeBudgetCap.value = bc;
		} catch { /* keep the 5M fallback */ }
		if (!isAdminRole.value) {
			const uid = (host.currentUser() as any)?.id;
			if (uid) {
				try {
					const me = await api.get('/items/people', { params: { filter: { user_id: { _eq: uid } }, limit: 1, fields: ['person_id'] } });
					myPersonId.value = me.data?.data?.[0]?.person_id ?? null;
				} catch { myPersonId.value = null; }
			}
		}

		const filter: any = { status: { _eq: 'done' } };
		if (!isAdminRole.value) {
			if (!myPersonId.value) {
				// No linked people row for this account — show nothing rather than
				// accidentally matching rows with a NULL owner via `_eq: null`.
				rows.value = [];
				return;
			}
			// Related to me = I own the sample, own the operation, or ran it.
			filter._and = [{ _or: [
				{ 'operation_id.sample_id.owner_person_id': { _eq: myPersonId.value } },
				{ 'operation_id.owner_person_id': { _eq: myPersonId.value } },
				{ 'operation_id.operator_person_id': { _eq: myPersonId.value } },
			] }];
		}

		const res = await api.get('/items/machining_force_analysis', {
			params: {
				filter,
				limit: -1,
				fields: [
					'id', 'peak_fx', 'peak_fy', 'peak_fz', 'status', 'live_cache_file', 'octree_status', 'created_at',
					'operation_id.operation_id', 'operation_id.pass_code', 'operation_id.operation_date',
					'operation_id.sample_id.sample_id', 'operation_id.sample_id.sample_code',
					'operation_id.sample_id.nickname', 'operation_id.sample_id.material_id.common_name',
					'operation_id.sample_id.owner_person_id.full_name',
					// Metadata Doctor (metadataDoctor.ts) runs client-side over this whole list, so every
					// value it compares has to be fetched here — the archive is ~190 rows and these are all
					// scalars, so widening the one existing `limit:-1` query is cheaper than a second pass.
					// CAUTION: Directus rejects the ENTIRE request if any one field is unknown to it, so a
					// typo here (or a schema change the running container hasn't picked up) empties the
					// whole dashboard, not just one check. `doctor_dismissed` in particular needs
					// `docker restart d1-database-directus-1` after its migration — AUTO_RELOAD does not
					// fire on Docker-Windows, and until then every query below returns FORBIDDEN.
					'n_raw', 'cut_start_idx', 'cut_end_idx', 'crop_start_idx_override', 'crop_end_idx_override',
					'feed', 'depth_of_cut', 'surface_speed', 'cut_diameter', 'outer_diameter',
					'trigger_time', 'doctor_dismissed',
					'operation_id.operation_sequence', 'operation_id.machining_operation_subtype',
					'operation_id.process_category', 'operation_id.machining_cutting_speed_m_per_min',
					'operation_id.machining_feed_mm_per_rev', 'operation_id.machining_axial_depth_of_cut_mm',
					'operation_id.machining_workpiece_diameter_mm',
				],
			},
		});
		rows.value = res.data.data ?? [];
		// Deep-link: /d1-force-dashboard?operation=<operation_id>, e.g. from the
		// "View Force Analysis" button on the operation form. Falls back to the last
		// selection (persisted) so navigating away and back restores the view.
		// The rest of the query (mode, axes, zoom, compare set ...) is applied once the op has loaded.
		const initialView = decodeViewState(route.query);
		const opParam = initialView.operation
			?? (() => { try { return localStorage.getItem(LAST_OP_KEY) || undefined; } catch { return undefined; } })();
		if (opParam) await showView({ ...initialView, operation: opParam });
	} finally {
		viewReady = true;   // from here on the address bar follows the view
		loading.value = false;
		// .layout swaps from hidden to visible here; re-measure in case the
		// spinner-to-content swap shifted anything (defensive, cheap).
		await nextTick();
		measureLayout();
	}
});

// #24 keeps this component alive across navigation, so onBeforeUnmount alone never fires when
// the operator leaves /plot -- these blob URLs would otherwise accumulate for the rest of the
// session as more operations are browsed. Clear frmCache too, not just revoke: the Map itself
// survives deactivation (this closure isn't destroyed), so a stale revoked URL would otherwise
// be handed back to loadFrm()'s `frmCache.has(fileId)` fast path on reactivation.
function releaseFrmCache() {
	for (const u of frmCache.values()) URL.revokeObjectURL(u);
	frmCache.clear();
}
onDeactivated(releaseFrmCache);
onBeforeUnmount(releaseFrmCache);
// The host polls (bake, octree, render) stop on unmount; they deliberately keep running across a
// keep-alive deactivate (see opGuard above).
onBeforeUnmount(() => { activation.clear(); stopHostPolls(); });

function sampleOf(r: any) { return r.operation_id?.sample_id; }

// Numeric-aware comparators: "10-AA-MF-..." must sort after "2-AA-MF-..." (the
// leading counter), and "F10" after "F2" (the pass number) — plain string
// compare puts "10" before "2" since only the first character is read.
function leadingInt(s: string | null | undefined): number {
	const m = /^(\d+)/.exec(s || '');
	return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}
function passNumber(code: string | null | undefined): number {
	const m = /F(\d+)/i.exec(code || '');
	return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}
function bySampleCode(a: any, b: any) {
	const d = leadingInt(a.sample_code) - leadingInt(b.sample_code);
	return d !== 0 ? d : (a.sample_code || '').localeCompare(b.sample_code || '');
}
function byPassCode(a: any, b: any) {
	const ca = a.operation_id?.pass_code, cb = b.operation_id?.pass_code;
	const d = passNumber(ca) - passNumber(cb);
	return d !== 0 ? d : (ca || '').localeCompare(cb || '');
}

const samples = computed(() => {
	const map = new Map<string, any>();
	for (const r of rows.value) {
		const s = sampleOf(r);
		if (!s?.sample_id) continue;
		let e = map.get(s.sample_id);
		if (!e) {
			e = { sample_id: s.sample_id, sample_code: s.sample_code, nickname: s.nickname,
				material: s.material_id?.common_name, owner: s.owner_person_id?.full_name, ops: [] as any[] };
			map.set(s.sample_id, e);
		}
		e.ops.push(r);
	}
	const arr = [...map.values()];
	arr.sort(bySampleCode);
	return arr;
});

const filteredSamples = computed(() => {
	const q = sampleSearch.value.trim().toLowerCase();
	return q ? samples.value.filter((s) =>
		(s.sample_code || '').toLowerCase().includes(q) || (s.nickname || '').toLowerCase().includes(q)
		|| (s.material || '').toLowerCase().includes(q)) : samples.value;
});

// Most recently saved recording across ALL operations (not just the currently filtered/searched
// list) — created_at is a DB-level default (now()) set on insert regardless of which path wrote
// the row (force-app's direct upload or the MATLAB crawler), so it's a reliable "latest" signal
// independent of operation_date (which can be backdated/historical) or client-supplied timestamps.
const latestRowId = computed(() => {
	let best: any = null;
	for (const r of rows.value) {
		if (!r.created_at) continue;
		if (!best || new Date(r.created_at).getTime() > new Date(best.created_at).getTime()) best = r;
	}
	return best?.id ?? null;
});

// Data-quality stoplight for an operation row (mirrors the FAST dashboard). Green = a
// plottable FRM cache exists · Blue = processing · Yellow = octree-only (no live cache) ·
// Red = failed or no plot data.
function frmQuality(o: any): { level: string; label: string } {
	if (o?.status === 'pending' || o?.status === 'processing') return { level: 'blue', label: 'Processing…' };
	if (o?.live_cache_file) return { level: 'green', label: 'FRM plot ready' };
	if (o?.octree_status === 'done') return { level: 'yellow', label: 'Octree only (no live cache)' };
	if (o?.status === 'error') return { level: 'red', label: 'Processing failed' };
	return { level: 'red', label: 'No plot data' };
}

// ---- Metadata Doctor ------------------------------------------------------------------------
// Metadata health is a DIFFERENT axis from frmQuality above: that one answers "is this plottable",
// this one "do the .mat and D1 agree". They get separate markers on purpose — folding a feed
// conflict into "no plot data" would lose the distinction the user needs in order to act.
//
// The two noisy checks are opt-in (see metadataDoctor.ts): legacy pass_codes came from filenames
// rather than computeAutoCode, and docs/force-file-standards.md §7 records that dates in filenames
// and pass codes are frequently wrong — so both are informational and off until asked for.
const DOCTOR_OPTIONAL = [
	{ id: 'name.stale', label: 'Name vs fields' },
	{ id: 'date.trigger', label: 'Recording vs operation date' },
];
const DOCTOR_OPTS_KEY = 'd1-force-doctor-opts';
const DOCTOR_ONLY_KEY = 'd1-force-doctor-only';
function loadStoredList(key: string): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(key) || 'null');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch { return []; }
}
const doctorScope = ref<'op' | 'all'>('op');
const doctorOptional = ref<string[]>(loadStoredList(DOCTOR_OPTS_KEY));
const issuesOnly = ref((() => { try { return localStorage.getItem(DOCTOR_ONLY_KEY) === '1'; } catch { return false; } })());
watch(doctorOptional, (v) => { try { localStorage.setItem(DOCTOR_OPTS_KEY, JSON.stringify(v)); } catch { /* ignore */ } }, { deep: true });
watch(issuesOnly, (v) => { try { localStorage.setItem(DOCTOR_ONLY_KEY, v ? '1' : '0'); } catch { /* ignore */ } });

// Findings per list row, recomputed whenever a row or the enabled-check set changes. Cached in one
// Map rather than called per-cell: the dot, the filter, the counts and the panel all want the same
// answer, and diagnose() runs over every row in the list.
const doctorByRow = computed(() => {
	const opts = doctorOptional.value;
	const m = new Map<string, Finding[]>();
	for (const r of rows.value) m.set(r.id, diagnose(r, opts));
	return m;
});
function doctorFindingsFor(r: any): Finding[] { return doctorByRow.value.get(r?.id) ?? []; }
function doctorQuality(r: any): { level: string; label: string; count: number } | null {
	const active = activeFindings(doctorFindingsFor(r));
	if (!active.length) return null;
	const level = worstSeverity(doctorFindingsFor(r)) ?? 'info';
	const head = active[0].title;
	return {
		level,
		count: active.length,
		label: active.length === 1 ? head : `${head} (+${active.length - 1} more)`,
	};
}
// Every operation carrying at least one finding that still needs action.
const doctorFlaggedCount = computed(() =>
	rows.value.reduce((n, r) => n + (activeFindings(doctorFindingsFor(r)).length ? 1 : 0), 0));

const displayedOps = computed(() => {
	let list = filterSampleId.value
		? rows.value.filter((r) => sampleOf(r)?.sample_id === filterSampleId.value)
		: rows.value.slice();
	const q = opSearch.value.trim().toLowerCase();
	if (q) list = list.filter((r) =>
		(r.operation_id?.pass_code || '').toLowerCase().includes(q)
		|| (sampleOf(r)?.sample_code || '').toLowerCase().includes(q));
	if (issuesOnly.value) list = list.filter((r) => activeFindings(doctorFindingsFor(r)).length > 0);
	return list.sort(byPassCode);
});

const selectedSample = computed(() => samples.value.find((s) => s.sample_id === selectedSampleId.value) || null);

function selectSample(s: any) {
	if (filterSampleId.value === s.sample_id) {
		filterSampleId.value = null;
		selectedSampleId.value = null;
		return;
	}
	filterSampleId.value = s.sample_id;
	selectedSampleId.value = s.sample_id;
	if (detail.value && sampleOf(detail.value)?.sample_id !== s.sample_id) {
		selectedRowId.value = null; detail.value = null; frmUrl.value = null;
	}
}

const LAST_OP_KEY = 'd1-force-dashboard-lastop';
const selectToken = createLoadToken();
async function selectOp(row: any) {
	selectedRowId.value = row.id;
	selectedSampleId.value = sampleOf(row)?.sample_id ?? null;
	// selectSample() (clicking a sample directly) narrows the Operations list to just that
	// sample's ops via filterSampleId — selectOp() never did, so a deep link (?operation=...) or
	// any other caller of selectOp() left the Operations list showing everything/whatever was
	// previously filtered, with the "selected" row buried in there rather than the list actually
	// narrowing to match. This is the "sample list doesn't self-filter" bug.
	filterSampleId.value = selectedSampleId.value;
	// Bring both the sample and operation rows into view — necessary for a deep link (the match
	// can be scrolled far outside the initial viewport in a long list), harmless on a direct click
	// (scrollIntoView is a no-op when the row is already visible).
	nextTick(() => {
		document.querySelector('.panel-samples .rowcard.active')?.scrollIntoView({ block: 'nearest' });
		document.querySelector('.panel-ops .rowcard.active')?.scrollIntoView({ block: 'nearest' });
	});
	// Remember the selection so navigating away and back restores it.
	try { const opId = row.operation_id?.operation_id; if (opId) localStorage.setItem(LAST_OP_KEY, opId); } catch { /* ignore */ }
	// The previous op stays on screen, under a veil, until this one arrives: clearing it here
	// unmounted every chart and the cloud, so each switch flashed blank and reflowed (#94). A
	// newer click supersedes this one, so a slow response can't land on top of it.
	const seq = selectToken.next();
	loadingDetail.value = true;
	try {
		const res = await api.get(`/items/machining_force_analysis/${row.id}`, {
			params: {
				fields: ['*',
					'operation_id.operation_id', 'operation_id.pass_code', 'operation_id.operation_date',
					'operation_id.operation_sequence', 'operation_id.machining_operation_subtype',
					'operation_id.process_category', 'operation_id.operator_name',
					'operation_id.machining_new_edge', 'operation_id.machining_coolant_used', 'operation_id.outcome_notes',
					// Needed by the wear-trend panel to group an edge's passes. `*` above covers only
					// machining_force_analysis's own columns, not the related operation's, so without
					// this the edge grouping silently finds nothing and falls back to sample.
					'operation_id.insert_edge_id', 'operation_id.machining_cutting_length_mm',
					// Needed by computeAutoCode() (operationCode.ts) to regenerate the operation's name —
					// without these the regenerated pass_code silently drops its parameter suffix.
					'operation_id.machining_cutting_speed_m_per_min', 'operation_id.machining_feed_mm_per_rev',
					'operation_id.machining_axial_depth_of_cut_mm',
					// Needed by the Metadata Doctor's diameter pair (metadataDoctor.ts). `*` above covers
					// only machining_force_analysis's own columns, so without this the check reads the
					// operation's diameter as null and reports a spurious backfill.
					'operation_id.machining_workpiece_diameter_mm', 'operation_id.machining_spindle_speed_rpm',
					'operation_id.equipment_id.equipment_name', 'operation_id.method_id.method_name',
					'operation_id.sample_id.sample_id', 'operation_id.sample_id.sample_code', 'operation_id.sample_id.nickname',
					'operation_id.sample_id.form', 'operation_id.sample_id.manufactured_date',
					'operation_id.sample_id.owner_person_id.full_name',
					'operation_id.sample_id.material_id.common_name',
					'directus_files_id.filesize', 'live_cache_file', 'live_render_points', 'pulses_per_rev', 'inner_diameter', 'outer_diameter', 'filter_chain', 'filter_baked',
					'octree_status', 'octree_path', 'octree_points',
					'grid_octree_status', 'grid_octree_path', 'grid_octree_points',
					'grid_fidelity', 'grid_arm_ratio', 'grid_cell_mm'],
			},
		});
		if (!selectToken.isCurrent(seq)) return;
		detail.value = res.data.data;
		editPpr.value = Number(detail.value?.pulses_per_rev) || 1;
		// The figure is not loaded here: it is only shown in Figure mode, and the figure watcher
		// (below) fetches it, not awaited, once the new detail is in place. Waiting for
		// it would hold the veil (and its pointer block) over Lite/Full; Figure mode shows its own
		// download overlay while frmLoading.
	} catch (e) {
		// Nothing to show for the selected row: don't leave the previous op displayed as if it were it.
		if (selectToken.isCurrent(seq)) { detail.value = null; frmUrl.value = null; frmToken.cancel(); frmLoading.value = false; }
		throw e;
	} finally {
		if (selectToken.isCurrent(seq)) loadingDetail.value = false;
	}
}

// Latest loadFrm() wins: an older figure download finishing late must not land on the newer op, or
// clear frmLoading while the newer one is still downloading.
const frmToken = createLoadToken();
async function loadFrm() {
	// Deactivated: releaseFrmCache() just emptied frmCache, and a figure fetched now would be cached
	// again with nobody to release it. Reload on return (it reads the then-current op).
	if (!activation.active) { activation.whenActive(() => { void loadFrm(); }); return; }
	const mine = frmToken.next();
	const d = detail.value;
	if (!d) { frmUrl.value = null; frmLoading.value = false; return; }
	const fileId = d[`frm_${axis.value.toLowerCase()}`];
	if (!fileId) { frmUrl.value = null; frmLoading.value = false; return; }
	if (frmCache.has(fileId)) { frmUrl.value = frmCache.get(fileId)!; frmLoading.value = false; return; }
	frmLoading.value = true;
	figStage.value = { kind: 'download', loaded: 0, total: null, what: 'figure' };
	try {
		const res = await api.get(`/assets/${fileId}`, {
			responseType: 'blob',
			onDownloadProgress: (e) => {
				if (!frmToken.isCurrent(mine)) return;
				// Progress events are frequent; only write when the label would change (whole percent).
				const next: LoadStage = { kind: 'download', loaded: e.loaded, total: e.total ?? null, what: 'figure' };
				if (!sameStage(figStage.value, next)) figStage.value = next;
			},
		});
		const url = URL.createObjectURL(res.data);
		frmCache.set(fileId, url);   // cached even when superseded: it is the right figure for that file
		if (!frmToken.isCurrent(mine)) return;
		frmUrl.value = url;
	} catch { if (frmToken.isCurrent(mine)) frmUrl.value = null; } finally { if (frmToken.isCurrent(mine)) frmLoading.value = false; }
}
// The static figure is only on screen when neither interactive renderer is (Lite needs a live cache,
// Full an octree, so a mode with nothing behind it falls back to the figure too). Fetch it only
// then, and again whenever the file to show changes (a new operation, another axis) or the figure
// comes back on screen (a switch to Figure). The cache above makes a revisit instant.
const figureShown = computed(() => !liveOn.value && !octreeOn.value);
const figureFileId = computed<string | null>(() => detail.value?.[`frm_${axis.value.toLowerCase()}`] ?? null);
watch([figureShown, figureFileId], () => { if (figureShown.value) void loadFrm(); });
function setAxis(a: Axis) { axis.value = a; }

const op = computed(() => detail.value?.operation_id ?? null);
const opSample = computed(() => op.value?.sample_id ?? null);
const opLabel = computed(() => op.value?.pass_code || opSample.value?.sample_code || '—');

// ---- Editable operation metadata (Subtype/Sequence/New edge/Coolant/Operator/cutting params/
// notes/name) — the plotting view previously showed these read-only. Combined with the crop
// save into one dialog (see saveChanges() below). Machine/Method (equipment_id/method_id
// relations) stay read-only: editing them needs option-list fetches from collections not
// otherwise touched in this package, and they don't feed name regeneration.
// NOTE: this block must stay textually after `op`/`opSample` above — watch(regeneratedPassCode,
// ...) below evaluates its source once, synchronously, at setup (even without immediate:true),
// and regeneratedPassCode reads op.value; declaring it before op's own `const` throws a TDZ
// ReferenceError the moment this component mounts (a plain function declaration like
// seedMetaFromDetail would be hoisted and fine either way — it's specifically the eager
// watch-of-a-computed pattern that requires this ordering).
const srcMeta = reactive({
	subtype: '', sequence: null as number | null, newEdge: null as boolean | null, coolant: null as boolean | null,
	operator: '', cuttingSpeed: null as number | null, feedMmPerRev: null as number | null, axialDoc: null as number | null,
	workpieceDiam: null as number | null,
	outcomeNotes: '', passCode: '',
});
const editOpSubtype = ref('');
// The edited subtype previews the metrics (op kind, spiral). With no operation the editOp* refs keep
// the previous operation's values (seedMetaFromDetail returns early), so ignore them then.
const cutSubtype = computed(() => op.value ? (editOpSubtype.value || op.value.machining_operation_subtype || '') : '');
// The axis-map memory is keyed on the SAVED subtype, so a choice made while the Subtype field holds
// unsaved or half-typed text is not stored under that text.
const axisMapSubtype = computed(() => op.value?.machining_operation_subtype || '');
const axisMapSel = ref(axisMapKey(resolveAxisMap(axisMapSubtype.value)));
// Load the remembered choice when the operation (subtype) changes; a change made in the select is
// written in onAxisMapChange, so loading never writes.
watch(axisMapSubtype, (st) => { axisMapSel.value = axisMapKey(resolveAxisMap(st)); });
const editOpNewEdge = ref<boolean | null>(null);
const editOpCoolant = ref<boolean | null>(null);
const editOperatorName = ref('');
// Named editOp* (not editFeed/editDiam) to avoid colliding with the point-cloud geometry
// overrides above, which are a different table and a different meaning despite similar names.
const editOpCuttingSpeed = ref<number | null>(null);   // machining_cutting_speed_m_per_min (Vc)
const editOpFeedMmPerRev = ref<number | null>(null);   // machining_feed_mm_per_rev
const editOpAxialDoc = ref<number | null>(null);       // machining_axial_depth_of_cut_mm
// The operation record's own workpiece diameter. NOT the same field as the FRM "Diameter" control
// above (that one is machining_force_analysis.outer_diameter, a geometry override for the spiral):
// this is the operation's recorded stock diameter, and unlike the three params above it does not
// feed computeAutoCode, so editing it never changes the operation name.
const editOpWorkpieceDiam = ref<number | null>(null);  // machining_workpiece_diameter_mm
const editOutcomeNotes = ref('');
function seedMetaFromDetail() {
	const o = op.value; if (!o) return;
	srcMeta.subtype = o.machining_operation_subtype || '';
	srcMeta.sequence = o.operation_sequence ?? null;
	srcMeta.newEdge = o.machining_new_edge ?? null;
	srcMeta.coolant = o.machining_coolant_used ?? null;
	srcMeta.operator = o.operator_name || '';
	srcMeta.cuttingSpeed = o.machining_cutting_speed_m_per_min ?? null;
	srcMeta.feedMmPerRev = o.machining_feed_mm_per_rev ?? null;
	srcMeta.axialDoc = o.machining_axial_depth_of_cut_mm ?? null;
	srcMeta.workpieceDiam = o.machining_workpiece_diameter_mm ?? null;
	srcMeta.outcomeNotes = o.outcome_notes || '';
	srcMeta.passCode = o.pass_code || '';
	editOpSubtype.value = srcMeta.subtype;
	editOpNewEdge.value = srcMeta.newEdge;
	editOpCoolant.value = srcMeta.coolant;
	editOperatorName.value = srcMeta.operator;
	editOpCuttingSpeed.value = srcMeta.cuttingSpeed;
	editOpFeedMmPerRev.value = srcMeta.feedMmPerRev;
	editOpAxialDoc.value = srcMeta.axialDoc;
	editOpWorkpieceDiam.value = srcMeta.workpieceDiam;
	editOutcomeNotes.value = srcMeta.outcomeNotes;
}
// The name computeAutoCode() would produce from the currently-edited fields — recomputed live
// so the combined-save dialog can show "old -> new" before the user confirms. Operation code and
// Sequence are NOT user-editable (see edit-grid below): the code is purely a consequence of the
// other fields, and Sequence is the key archive .mat filenames are matched to an operation by
// (see docs/superpowers/specs .mat-operation-linking notes) — hand-editing it here would silently
// desync that link, so it stays fixed at whatever seedMetaFromDetail() loaded.
const regeneratedPassCode = computed(() => {
	const o = op.value; if (!o) return '';
	return computeAutoCode({
		processCategory: o.process_category,
		sampleCode: opSample.value?.sample_code ?? null,
		operationSequence: srcMeta.sequence,
		machiningOperationSubtype: editOpSubtype.value,
		machiningCuttingSpeedMPerMin: editOpCuttingSpeed.value,
		machiningFeedMmPerRev: editOpFeedMmPerRev.value,
		machiningAxialDepthOfCutMm: editOpAxialDoc.value,
	});
});
const metaDirty = computed(() => {
	if (!op.value) return false;
	return editOpSubtype.value !== srcMeta.subtype
		|| editOpNewEdge.value !== srcMeta.newEdge
		|| editOpCoolant.value !== srcMeta.coolant
		|| editOperatorName.value !== srcMeta.operator
		|| numDiffers(numOrNull(editOpCuttingSpeed.value), srcMeta.cuttingSpeed)
		|| numDiffers(numOrNull(editOpFeedMmPerRev.value), srcMeta.feedMmPerRev)
		|| numDiffers(numOrNull(editOpAxialDoc.value), srcMeta.axialDoc)
		|| numDiffers(numOrNull(editOpWorkpieceDiam.value), srcMeta.workpieceDiam)
		|| editOutcomeNotes.value !== srcMeta.outcomeNotes
		|| (regeneratedPassCode.value !== '' && regeneratedPassCode.value !== srcMeta.passCode);
});

// ---- Metadata Doctor, selected operation ----------------------------------------------------
// Diagnosed from `detail` (not the list row) so the panel reflects edits the moment they're saved
// and the detail row is refreshed. Falls back to the list row while the detail is still loading.
const doctorFindings = computed<Finding[]>(() => {
	const d = detail.value;
	if (d) return diagnose(d, doctorOptional.value);
	const r = rows.value.find((x) => x.id === selectedRowId.value);
	return r ? doctorFindingsFor(r) : [];
});
const doctorActive = computed(() => activeFindings(doctorFindings.value));
const doctorDismissedList = computed(() => doctorFindings.value.filter((f) => f.dismissed));

// The `adopt` fix writes the .mat's value into the operation record by seeding the SAME edit ref
// the metadata box binds to, so the change flows through the existing combined save dialog (one
// confirm, one write, old -> new summary) instead of introducing a second write path.
const ADOPT_TARGETS: Record<string, { ref: typeof editOpFeedMmPerRev; label: string }> = {
	machining_feed_mm_per_rev: { ref: editOpFeedMmPerRev, label: 'Feed' },
	machining_axial_depth_of_cut_mm: { ref: editOpAxialDoc, label: 'Depth of cut' },
	machining_cutting_speed_m_per_min: { ref: editOpCuttingSpeed, label: 'Surface speed' },
	machining_workpiece_diameter_mm: { ref: editOpWorkpieceDiam, label: 'Workpiece Ø' },
};
// The numeric test belongs HERE, not in adoptFinding: canAdopt gates whether the button renders,
// so if the two disagree the UI can offer a button whose handler silently refuses to act.
function canAdopt(f: Finding): boolean {
	return f.fix === 'adopt' && typeof f.matValue === 'number' && !!f.field && f.field in ADOPT_TARGETS;
}
// Feed/DoC/Vc all feed computeAutoCode, so adopting one can change the derived operation code —
// that's surfaced as an ordinary "Operation code" row in the save-changes summary below, same as
// any other consequence of an edited field. Nothing here writes pass_code directly: it is never
// user-editable (see edit-grid), only ever the live output of regeneratedPassCode.
function adoptFinding(f: Finding) {
	if (!canAdopt(f)) return;
	const t = ADOPT_TARGETS[f.field!];
	t.ref.value = f.matValue as number;
	// Reveal the metadata box holding the field we just seeded, so the pending edit is visible
	// rather than silently staged behind a folded accordion.
	openPanel.value = 'detail';
}
function applyFix(f: Finding) {
	if (f.fix === 'adopt') return adoptFinding(f);
	// The regenerated code is already live (regeneratedPassCode) and not user-editable, so
	// there's nothing to "regenerate" — just reveal the box so the pending rename is visible
	// in the save-changes summary before the user confirms.
	if (f.fix === 'regen') { openPanel.value = 'detail'; return; }
	if (f.fix === 'crop') return startCropFix();
	if (f.fix === 'link') return openOpForm();
}
// No auto-fix for a bad crop: the right window is a human judgement. Put the crop handles in front
// of the user instead — Lite is the only mode that recomputes the crop live (see onCropEdit).
function startCropFix() {
	if (liveAvailable.value) chooseMode('lite');
	document.querySelector('.charts-col')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const doctorBusy = ref('');
const doctorErr = ref('');
async function setDismissed(f: Finding, dismissed: boolean) {
	const d = detail.value;
	if (!d) return;
	doctorBusy.value = f.id;
	doctorErr.value = '';
	const next: Record<string, any> = { ...(d.doctor_dismissed || {}) };
	if (dismissed) next[f.id] = { sig: f.sig, at: new Date().toISOString(), by: host.currentUser()?.id ?? null };
	else delete next[f.id];
	const payload = Object.keys(next).length ? next : null;
	try {
		await api.patch(`/items/machining_force_analysis/${d.id}`, { doctor_dismissed: payload });
		d.doctor_dismissed = payload;
		// Keep the list row in step so the dot and the "issues only" filter update without a refetch.
		const r = rows.value.find((x) => x.id === d.id);
		if (r) r.doctor_dismissed = payload;
	} catch (e: any) {
		doctorErr.value = e?.response?.status === 403 ? 'Not permitted' : 'Could not save';
	} finally { doctorBusy.value = ''; }
}

// "All operations" mode: every finding across the archive, grouped by check, worst severity first.
const doctorGroups = computed(() => {
	const g = new Map<string, { id: string; title: string; severity: string; rows: any[] }>();
	for (const r of rows.value) {
		for (const f of activeFindings(doctorFindingsFor(r))) {
			let e = g.get(f.id);
			if (!e) { e = { id: f.id, title: f.title, severity: f.severity, rows: [] }; g.set(f.id, e); }
			e.rows.push(r);
		}
	}
	const rank: Record<string, number> = { error: 3, warn: 2, info: 1 };
	return [...g.values()].sort((a, b) =>
		(rank[b.severity] - rank[a.severity]) || (b.rows.length - a.rows.length));
});
function toggleOptionalCheck(id: string) {
	const i = doctorOptional.value.indexOf(id);
	if (i >= 0) doctorOptional.value.splice(i, 1);
	else doctorOptional.value.push(id);
}

// Sample info: rich from the loaded operation, else the light list row.
const sampleInfo = computed(() => {
	if (opSample.value) {
		const s = opSample.value;
		return { id: s.sample_id, sample_code: s.sample_code, material: s.material_id?.common_name,
			nickname: s.nickname, form: s.form, owner: s.owner_person_id?.full_name,
			manufactured: s.manufactured_date, ops: samples.value.find((x) => x.sample_id === s.sample_id)?.ops.length };
	}
	if (selectedSample.value) {
		const s = selectedSample.value;
		return { id: s.sample_id, sample_code: s.sample_code, material: s.material, nickname: s.nickname, owner: s.owner, ops: s.ops.length };
	}
	return null;
});

// Subtype/Sequence/New edge/Coolant/Operator moved into the editable "Operation metadata" box
// below (srcMeta/editOp*) — kept out of this read-only list so they aren't shown twice.
const opMeta = computed(() => {
	const o = op.value;
	if (!o) return [];
	return [
		['Date', fmtDate(o.operation_date)],
		['Recorded', fmtDateTime(detail.value?.trigger_time)],
		['Machine', o.equipment_id?.equipment_name],
		['Method', o.method_id?.method_name],
	].filter(([, v]) => v != null && v !== '');
});

function fmtBytes(n: number | null | undefined): string {
	if (!n) return '—';
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
	return `${n} B`;
}
function fmtCutTime(d: any): string {
	if (!d?.sample_rate || d.cut_start_idx == null || d.cut_end_idx == null) return '—';
	const secs = (d.cut_end_idx - d.cut_start_idx) / d.sample_rate;
	if (secs >= 60) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
	return `${secs.toFixed(1)}s`;
}

// Capture/technical info: rarely needed at a glance -> its own collapsed accordion.
const captureInfo = computed(() => {
	const d = detail.value;
	if (!d) return [];
	return [
		['Sample rate', d.sample_rate ? `${(d.sample_rate / 1000).toFixed(1)} kHz` : '—'],
		['Dyno gain', d.dyno_gain != null ? `${fmt(d.dyno_gain)} N/V` : '—'],
		['Pulses/rev', d.pulses_per_rev != null ? String(d.pulses_per_rev) : '—'],
		['Raw points', d.n_raw != null ? Number(d.n_raw).toLocaleString() : '—'],
		['File version', d.file_version != null ? String(d.file_version) : '—'],
		['File size', fmtBytes(d.directus_files_id?.filesize)],
	].filter(([, v]) => v !== '—') as [string, string][];
});
// Accordion state for the reworked op panel (persist nothing; sensible defaults).
const captureOpen = ref(false);

// The user picking a view type. Choosing Lite collapses the sample detail + the op's date/coolant
// rows to free vertical space for the crop plots, cloud, and plotting-settings panel. Only a
// deliberate choice does that: this used to be a watcher on frmMode, so the automatic re-pick when
// a different file loaded reflowed the whole layout (#94).
function chooseMode(m: FrmMode) {
	preferredMode.value = m;
	frmMode.value = m;
	sampleDetailOpen.value = m !== 'lite';
	if (m === 'lite') chartMode.value = 'force';
}

// The window that actually feeds the FRM map (cut_start_idx..cut_end_idx into
// the raw signal); converted to seconds so ForceChart can shade it in vs. the
// discarded lead-in/out at lower saturation.
const cropWindow = computed(() => {
	const d = detail.value;
	if (!d || !d.sample_rate || d.cut_start_idx == null || d.cut_end_idx == null) return null;
	return { start: d.cut_start_idx / d.sample_rate, end: d.cut_end_idx / d.sample_rate };
});

// A human-saved crop override (crop_start_idx_override / crop_end_idx_override on the op record),
// in seconds. When present it wins over both the derived cut_start_idx and the cache's own csSec —
// mirroring how outer_diameter overrides the cache's diameter. NULL columns = follow the derived
// auto-crop, so "reset to auto" and a reprocess both still land on the machine-detected window.
const savedCropSec = computed(() => {
	const d = detail.value;
	if (!d || !d.sample_rate || d.crop_start_idx_override == null || d.crop_end_idx_override == null) return null;
	return { start: d.crop_start_idx_override / d.sample_rate, end: d.crop_end_idx_override / d.sample_rate };
});
// The current handle position differs from what's persisted (override if saved, else the auto
// window) by more than a sample — i.e. there's something worth offering to save. Only meaningful
// in Live mode, where the handles are actually editable.
const cropDirty = computed(() => {
	const d = detail.value;
	if (!liveOn.value || !d || !d.sample_rate) return false;
	const base = savedCropSec.value || cropWindow.value;
	if (!base) return cropStartSec.value > 0 || cropEndSec.value > 0;
	const tol = 1 / d.sample_rate;   // one sample
	return Math.abs(cropStartSec.value - base.start) > tol || Math.abs(cropEndSec.value - base.end) > tol;
});
// Persist the current crop handles as the op's official crop (see the migration
// 20260828000103_force_crop_override). Writes sample indices, not seconds, to match cut_start_idx.
// Editing the handles back to the auto window and saving clears the override (NULL = follow auto).
async function saveCropAsOfficial() {
	const d = detail.value;
	if (!d?.id || !d.sample_rate || cropSaving.value) return;
	cropSaving.value = true; cropSavedMsg.value = '';
	const auto = cropWindow.value;
	const tol = 1 / d.sample_rate;
	const backToAuto = !!auto && Math.abs(cropStartSec.value - auto.start) <= tol && Math.abs(cropEndSec.value - auto.end) <= tol;
	const startIdx = backToAuto ? null : Math.max(0, Math.round(cropStartSec.value * d.sample_rate));
	const endIdx = backToAuto ? null : Math.max(0, Math.round(cropEndSec.value * d.sample_rate));
	// A previously-built Full-res octree (plain or gridded) was baked from the old crop window —
	// once the crop changes it no longer matches the signal shown everywhere else, so invalidate
	// it the same way the manual "Build" buttons request a build (#10): flip status back to
	// 'pending' with a fresh *_requested_at, which the host-side force orchestrator already polls
	// for (see buildOctree/buildGridOctree above). Lite reads live_cache_file directly and is
	// already always current; Figure mode (frm_fx/fy/fz) has no such live-triggerable rebuild path.
	const invalidate: Record<string, any> = {};
	const now = new Date().toISOString();
	// 'error' is re-queued too: a failed build has nothing to keep, and the retry picks up the new crop.
	// 'pending'/'processing' are left alone: a pending build reads the new crop when it starts, and the
	// host re-queues a running one when it finishes (its done UPDATE sees the override changed).
	const requeue = (st: unknown) => st === 'done' || st === 'error';
	if (requeue(d.octree_status)) { invalidate.octree_status = 'pending'; invalidate.octree_requested_at = now; }
	if (requeue(d.grid_octree_status)) { invalidate.grid_octree_status = 'pending'; invalidate.grid_octree_requested_at = now; }
	const building = d.octree_status === 'processing' || d.grid_octree_status === 'processing';
	try {
		await api.patch(`/items/machining_force_analysis/${d.id}`, { crop_start_idx_override: startIdx, crop_end_idx_override: endIdx, ...invalidate });
		d.crop_start_idx_override = startIdx; d.crop_end_idx_override = endIdx;   // so cropDirty/savedCropSec update
		// The octree being rebuilt is not the user choosing another view: re-pick from their preference
		// (Full -> Lite/Figure while it is pending) so preferredMode stays 'full' and the view returns
		// to it when the build lands, with no layout side effects.
		if (invalidate.octree_status) { d.octree_status = 'pending'; if (frmMode.value === 'full' && !gridFull.value) frmMode.value = pickDefaultMode(); }
		if (invalidate.grid_octree_status) { d.grid_octree_status = 'pending'; if (frmMode.value === 'full' && gridFull.value) frmMode.value = pickDefaultMode(); }
		cropTouched.value = false;
		pendingCrop.clear();   // the saved window is now the truth; a link's crop request must not re-apply
		cropSavedMsg.value = (backToAuto ? 'Reverted to auto crop' : 'Saved as official crop')
			+ (building ? ' (the build in progress is redone with it afterwards)' : '');
		window.setTimeout(() => { cropSavedMsg.value = ''; }, building ? 6000 : 2500);
	} catch (e: any) {
		cropSavedMsg.value = e?.response?.status === 403 ? 'Not permitted to save' : 'Save failed';
	} finally { cropSaving.value = false; cropSavePrompt.value = false; }
}

// ---- Combined "Save changes" — metadata edits + crop, one dialog, one summary -------------
function fmtBool(b: boolean | null): string { return b == null ? '—' : (b ? 'Yes' : 'No'); }
function fmtOrDash(v: unknown): string { return (v == null || v === '') ? '—' : String(v); }
function buildMetaPatch(): Record<string, any> {
	const patch: Record<string, any> = {};
	if (editOpSubtype.value !== srcMeta.subtype) patch.machining_operation_subtype = editOpSubtype.value || null;
	if (editOpNewEdge.value !== srcMeta.newEdge) patch.machining_new_edge = editOpNewEdge.value;
	if (editOpCoolant.value !== srcMeta.coolant) patch.machining_coolant_used = editOpCoolant.value;
	if (editOperatorName.value !== srcMeta.operator) patch.operator_name = editOperatorName.value || null;
	if (numDiffers(numOrNull(editOpCuttingSpeed.value), srcMeta.cuttingSpeed)) patch.machining_cutting_speed_m_per_min = numOrNull(editOpCuttingSpeed.value);
	if (numDiffers(numOrNull(editOpFeedMmPerRev.value), srcMeta.feedMmPerRev)) patch.machining_feed_mm_per_rev = numOrNull(editOpFeedMmPerRev.value);
	if (numDiffers(numOrNull(editOpAxialDoc.value), srcMeta.axialDoc)) patch.machining_axial_depth_of_cut_mm = numOrNull(editOpAxialDoc.value);
	if (numDiffers(numOrNull(editOpWorkpieceDiam.value), srcMeta.workpieceDiam)) patch.machining_workpiece_diameter_mm = numOrNull(editOpWorkpieceDiam.value);
	if (editOutcomeNotes.value !== srcMeta.outcomeNotes) patch.outcome_notes = editOutcomeNotes.value || null;
	if (regeneratedPassCode.value && regeneratedPassCode.value !== srcMeta.passCode) patch.pass_code = regeneratedPassCode.value;
	return patch;
}
// What the confirmation dialog shows before writing — every changed field as old -> new, plus
// the crop window (if dirty) and the resulting operation name (if it differs). Sequence has no
// row here: it's not user-editable (see edit-grid), so it never differs from srcMeta.
const changeSummary = computed(() => {
	const rows: { label: string; from: string; to: string }[] = [];
	const push = (label: string, from: string, to: string) => { if (from !== to) rows.push({ label, from, to }); };
	push('Subtype', fmtOrDash(srcMeta.subtype), fmtOrDash(editOpSubtype.value));
	push('New edge', fmtBool(srcMeta.newEdge), fmtBool(editOpNewEdge.value));
	push('Coolant', fmtBool(srcMeta.coolant), fmtBool(editOpCoolant.value));
	push('Operator', fmtOrDash(srcMeta.operator), fmtOrDash(editOperatorName.value));
	if (numDiffers(numOrNull(editOpCuttingSpeed.value), srcMeta.cuttingSpeed)) rows.push({ label: 'Surface speed', from: fmtOrDash(srcMeta.cuttingSpeed), to: fmtOrDash(numOrNull(editOpCuttingSpeed.value)) });
	if (numDiffers(numOrNull(editOpFeedMmPerRev.value), srcMeta.feedMmPerRev)) rows.push({ label: 'Feed', from: fmtOrDash(srcMeta.feedMmPerRev), to: fmtOrDash(numOrNull(editOpFeedMmPerRev.value)) });
	if (numDiffers(numOrNull(editOpAxialDoc.value), srcMeta.axialDoc)) rows.push({ label: 'Depth of cut', from: fmtOrDash(srcMeta.axialDoc), to: fmtOrDash(numOrNull(editOpAxialDoc.value)) });
	if (numDiffers(numOrNull(editOpWorkpieceDiam.value), srcMeta.workpieceDiam)) rows.push({ label: 'Workpiece Ø', from: fmtOrDash(srcMeta.workpieceDiam), to: fmtOrDash(numOrNull(editOpWorkpieceDiam.value)) });
	push('Notes', fmtOrDash(srcMeta.outcomeNotes), fmtOrDash(editOutcomeNotes.value));
	if (cropTouched.value && cropDirty.value) {
		const base = savedCropSec.value || cropWindow.value;
		rows.push({
			label: 'Crop window',
			from: base ? `${base.start.toFixed(1)}–${base.end.toFixed(1)}s` : '—',
			to: `${cropStartSec.value.toFixed(1)}–${cropEndSec.value.toFixed(1)}s`,
		});
	}
	if (regeneratedPassCode.value && regeneratedPassCode.value !== srcMeta.passCode) {
		rows.push({ label: 'Operation code', from: fmtOrDash(srcMeta.passCode), to: regeneratedPassCode.value });
	}
	return rows;
});
const hasChanges = computed(() => metaDirty.value || (cropTouched.value && cropDirty.value));
const changesDialogOpen = ref(false);
const metaSaving = ref(false);
const metaSaveErr = ref('');
async function saveChanges() {
	const o = op.value;
	if (!o?.operation_id || metaSaving.value) return;
	metaSaving.value = true; metaSaveErr.value = '';
	try {
		const patch = buildMetaPatch();
		if (Object.keys(patch).length) {
			await api.patch(`/items/manufacturing_operations/${o.operation_id}`, patch);
			Object.assign(o, patch);   // optimistic update — op.value is detail.value.operation_id
			seedMetaFromDetail();      // re-snapshot srcMeta from the now-updated op
		}
	} catch (e: any) {
		metaSaveErr.value = e?.response?.status === 403 ? 'Not permitted to save this operation.' : (e?.message || 'metadata save failed');
		metaSaving.value = false;
		return;   // don't attempt the crop write if metadata failed — one clear error, no half-applied state
	}
	metaSaving.value = false;
	changesDialogOpen.value = false;
	if (cropTouched.value && cropDirty.value) await saveCropAsOfficial();
}

// Live and the chart mode (Force/FFT) are independent: Live drives the FRM cloud +
// editable crop, while the signal graphs can still be flipped to FFT. The crop
// range the force plots shade/drag is the live editable one when Live is on.
const effectiveMode = computed(() => chartMode.value);
// Outside Live, prefer a human-saved crop override over the derived auto-crop window — mirrors
// the priority already used by the detail.value?.id watch and onCloudLoaded() below. Without
// this, reopening a cut in Figure/Full silently showed the auto window even when a crop had
// been saved, because only the Live branch ever consulted savedCropSec.
const activeCrop = computed(() => (liveOn.value
	? { start: cropStartSec.value, end: cropEndSec.value }
	: (savedCropSec.value || cropWindow.value)));
// When live, drop the date/coolant-ish rows to free space (keep the essentials).
const HIDE_WHEN_LIVE = new Set(['Date', 'Recorded', 'Coolant', 'New edge', 'Sequence']);
const compactMeta = computed(() => (liveOn.value ? opMeta.value.filter((m) => !HIDE_WHEN_LIVE.has(m[0] as string)) : opMeta.value));

const PEAK_FIELD: Record<string, string> = { Fx: 'peak_fx', Fy: 'peak_fy', Fz: 'peak_fz' };
// Charts for one Signals panel instance — its own selected channels + RPM toggle (Force/FFT mode
// stays shared, since it's tied to the filter preview + FRM). At least one axis is kept on.
function buildChartsFor(item: RPanel) {
	const d = detail.value;
	const sel = (item.channels && item.channels.length ? item.channels : AXES) as readonly Axis[];
	const secondXLabel = 'radial (mm)';
	const base = AXES.filter((a) => sel.includes(a)).map((a) => (
		effectiveMode.value === 'force'
			? { key: a, title: `${a} · force`, kind: 'env' as const, data: d?.series?.[a], color: AXIS_COLOR[a], xUnit: 's', yUnit: 'N',
				cropStart: activeCrop.value?.start, cropEnd: activeCrop.value?.end, peak: d?.[PEAK_FIELD[a]],
				compare: compareSeriesFor(a),
				secondXValues: radialValuesFor(d?.series?.[a]?.t), secondXLabel }
			: { key: a, title: `${a} · spectrum`, kind: 'line' as const, data: d?.fft?.[a], color: AXIS_COLOR[a], xUnit: 'Hz', yUnit: 'N', logY: true }
	));
	if (effectiveMode.value === 'force' && item.rpm) {
		base.push({ key: 'RPM', title: 'RPM', kind: 'env', data: detail.value?.series?.RPM, color: '#a855f7', xUnit: 's', yUnit: 'rpm',
			cropStart: activeCrop.value?.start, cropEnd: activeCrop.value?.end,
			secondXValues: radialValuesFor(detail.value?.series?.RPM?.t), secondXLabel } as any);
	}
	return base;
}
// Cached per panel: the page re-renders on every hover move (hoverIndex), and rebuilding these
// inputs each time handed every ForceChart fresh compare/radial arrays, so each recomputed its
// O(N) geometry per mouse move (#100). Now they only change when their real inputs do.
const chartsFor = perKeyComputed((item: RPanel) => item.i, buildChartsFor);
// ---- Multi-cut comparison -----------------------------------------------------------------
// Overlay other operations' force envelopes on the current one, so successive passes on a single
// insert edge can be read against each other (tool wear shows as the force envelope growing pass
// over pass). Only `series` is fetched — the same JSONB envelope the charts already draw — so a
// comparison costs one small request per cut, not a live-cache download.
const COMPARE_COLORS = ['#f59e0b', '#a855f7', '#0ea5e9', '#ec4899', '#84cc16'];
const compareIds = ref<string[]>([]);
const compareData = ref<Record<string, any>>({});   // op row id -> { series, label }
const compareBusy = ref(false);
const comparePickerOpen = ref(false);

const compareCandidates = computed(() =>
	displayedOps.value.filter((o) => o.id !== selectedRowId.value && !compareIds.value.includes(o.id)),
);
const compareItems = computed(() =>
	compareIds.value
		.map((id, i) => ({ id, color: COMPARE_COLORS[i % COMPARE_COLORS.length], ...(compareData.value[id] || {}) }))
		.filter((c) => c.series),
);

function compareSeriesFor(axis: Axis) {
	return compareItems.value
		.map((c) => ({ id: c.id, label: c.label as string, color: c.color, data: c.series?.[axis] }))
		.filter((c) => c.data);
}

async function addCompare(row: any) {
	comparePickerOpen.value = false;
	if (compareIds.value.includes(row.id)) return;
	compareIds.value = [...compareIds.value, row.id];
	if (compareData.value[row.id]) return;
	compareBusy.value = true;
	try {
		// The crop fields ride along so the Difference can be limited to the cut itself (diffWindow).
		const res = await api.get(`/items/machining_force_analysis/${row.id}`, {
			params: { fields: ['series', 'sample_rate', 'cut_start_idx', 'cut_end_idx', 'crop_start_idx_override', 'crop_end_idx_override'] },
		});
		compareData.value = {
			...compareData.value,
			[row.id]: {
				series: res.data?.data?.series ?? null,
				crop: cropWindowSec(res.data?.data),
				label: row.operation_id?.pass_code || sampleOf(row)?.sample_code || row.id,
			},
		};
	} catch {
		// Drop it again rather than leaving a legend entry that draws nothing.
		compareIds.value = compareIds.value.filter((x) => x !== row.id);
	} finally { compareBusy.value = false; }
}
function removeCompare(id: string) { compareIds.value = compareIds.value.filter((x) => x !== id); }
function clearCompare() { compareIds.value = []; }

// ---- Difference vs a reference pass (compare.ts) ----------------------------------------------
// One chip can be marked as the reference; Difference then shows (this cut - reference) for the
// selected axis, from the envelopes Compare already loaded (no extra fetch), with its mean and RMS.
const compareRefId = ref<string | null>(null);
const diffOn = ref(false);
function toggleCompareRef(id: string) {
	compareRefId.value = compareRefId.value === id ? null : id;
	if (!compareRefId.value) diffOn.value = false;
}
// A removed chip can no longer be the reference.
watch(compareIds, (ids) => {
	if (compareRefId.value && !ids.includes(compareRefId.value)) { compareRefId.value = null; diffOn.value = false; }
});
const compareRefLabel = computed(() => (compareRefId.value && compareData.value[compareRefId.value]?.label) || '');
const diffResult = computed(() => {
	if (!diffOn.value || !compareRefId.value) return null;
	// Over the cuts themselves, not the whole recording: both crops (lead-in/out air would dominate
	// the stats), then the zoom. Compare draws each cut at its own recording time, so no shifting.
	const ref = compareData.value[compareRefId.value];
	const win = diffWindow(savedCropSec.value || cropWindow.value, ref?.crop, zoomStart.value, zoomEnd.value);
	return diffEnvelopes(detail.value?.series?.[axis.value], ref?.series?.[axis.value], win);
});
const DIFF_W = 260, DIFF_H = 44;
// Polyline of the difference, min/max-binned to the sparkline width so a spike is never averaged
// away; the zero line is drawn separately.
const diffSpark = computed(() => {
	const r = diffResult.value;
	if (!r) return null;
	const n = r.diff.length;
	let lo = 0, hi = 0;
	for (let i = 0; i < n; i++) { if (r.diff[i] < lo) lo = r.diff[i]; if (r.diff[i] > hi) hi = r.diff[i]; }
	const span = (hi - lo) || 1;
	const y = (v: number) => (DIFF_H - 3 - ((v - lo) / span) * (DIFF_H - 6)).toFixed(1);
	const bins = Math.min(n, DIFF_W);
	let d = '';
	for (let b = 0; b < bins; b++) {
		const i0 = Math.floor((b * n) / bins), i1 = Math.max(i0 + 1, Math.floor(((b + 1) * n) / bins));
		let bl = Infinity, bh = -Infinity;
		for (let i = i0; i < i1; i++) { if (r.diff[i] < bl) bl = r.diff[i]; if (r.diff[i] > bh) bh = r.diff[i]; }
		const x = ((b / Math.max(1, bins - 1)) * DIFF_W).toFixed(1);
		d += `${b ? 'L' : 'M'}${x},${y(bl)} L${x},${y(bh)} `;
	}
	return { d, zeroY: y(0), t0: r.t[0], t1: r.t[r.t.length - 1] };
});
const fmtDelta = (v: number) => `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toPrecision(3)}`;
// Selecting a different primary cut keeps the comparisons (comparing a series of passes is the
// whole point), but one that is now the primary must not also be drawn as a comparison.
watch(selectedRowId, (id) => { if (id) compareIds.value = compareIds.value.filter((x) => x !== id); });

// ---- Shareable view (viewState.ts) ----------------------------------------------------------
// The address bar mirrors the view so any URL is a link back to it. Both hosts run vue-router, so
// router.replace works unchanged in the standalone app and the Directus module. Writing waits for
// the initial query to be applied (viewReady), or the first change would erase what a pasted link
// asked for. The component is kept alive (#24), so a write is also skipped while another route is
// showing: the router is shared, and replacing its query then would corrupt that page's URL.
const viewPath = route.path;
let viewReady = false;
const pendingCrop = createPendingCrop();
const currentOperationId = computed<string | undefined>(
	() => rows.value.find((r) => r.id === selectedRowId.value)?.operation_id?.operation_id || undefined,
);
const viewState = computed<Partial<ViewState>>(() => ({
	operation: currentOperationId.value,
	mode: chartMode.value,
	axis: axis.value,
	zoom: zoomStart.value != null && zoomEnd.value != null ? [zoomStart.value, zoomEnd.value] : undefined,
	crop: liveOn.value && cropDirty.value ? [cropStartSec.value, cropEndSec.value] : undefined,
	compare: compareIds.value,
	reference: compareRefId.value ?? undefined,
	diff: diffOn.value,
	frm: frmMode.value,
	zSeries: zSeries.value,
	scale: locked.value
		? [colorScale.value.baseMin ?? colorScale.value.satMin, colorScale.value.baseMax ?? colorScale.value.satMax]
		: undefined,
}));
const viewQuery = computed(() => encodeViewState(viewState.value));
function mergedQuery(): Record<string, any> {
	const q: Record<string, any> = { ...route.query };
	for (const k of VIEW_QUERY_KEYS) delete q[k];
	return { ...q, ...viewQuery.value };
}
const writeViewQuery = debounce(() => {
	if (!viewReady || !activation.active || route.path !== viewPath || applyingIncoming) return;
	const q = mergedQuery();
	if (JSON.stringify(q) === JSON.stringify(route.query)) return;
	lastWrittenView = viewKeysOf(q);
	router.replace({ path: route.path, query: q, hash: route.hash }).catch(() => { /* a superseded navigation */ });
}, 400);
watch(viewQuery, writeViewQuery);
onDeactivated(() => writeViewQuery.cancel());
// Select the named op (when it isn't the one shown) and apply the rest of the view on top. Shared
// by first mount and by an incoming link while this page is kept alive. False if the op isn't in
// the list (nothing is changed then).
async function showView(v: Partial<ViewState>): Promise<boolean> {
	if (v.operation && v.operation !== currentOperationId.value) {
		const match = rows.value.find((r) => r.operation_id?.operation_id === v.operation);
		if (!match) return false;
		await selectOp(match);
	}
	await applyViewState(v);
	return true;
}
// This page is kept alive (#24), so route.query is not re-read by onMounted. An in-app push to
// /plot?operation=X (Save cut, Local capture) while another op is shown must show X, not have the
// address bar rewritten back to the old view 400 ms later. Only a route that adds nothing new is
// written over. `lastWrittenView` lets the route change our own write causes pass without being
// mistaken for an incoming link while the user keeps editing.
let applyingIncoming = false;
let lastWrittenView = '';
const viewKeysOf = (query: Record<string, any>) => JSON.stringify(VIEW_QUERY_KEYS.map((k) => query[k] ?? null));
async function followRoute() {
	if (!viewReady || !activation.active || route.path !== viewPath || applyingIncoming) return;
	if (viewKeysOf(route.query) === lastWrittenView) return;
	const d = incomingViewDecision(route.query, viewState.value);
	if (d.action === 'write') { writeViewQuery(); return; }
	applyingIncoming = true;
	try { await showView(d.view); }
	catch { /* a link naming something this op can't show: leave the view as it is */ }
	finally { applyingIncoming = false; }
	writeViewQuery();
}
onActivated(() => { lastWrittenView = ''; void followRoute(); });
watch(() => route.query, () => { void followRoute(); });
onBeforeUnmount(() => writeViewQuery.cancel());

function viewUrl(): string {
	return new URL(router.resolve({ path: route.path, query: mergedQuery(), hash: route.hash }).href, window.location.href).href;
}
const { copied: linkCopied, failed: linkCopyFailed, copy: copyViewLink } = useCopyFeedback(viewUrl);

// Apply a decoded view on top of the freshly loaded op. Each field is re-checked against what this
// op can actually show (a link can name a mode its cut has no cache for), and none can throw.
async function applyViewState(v: Partial<ViewState>) {
	await nextTick();   // let the op-change watchers (default mode, zoom/colour resets) settle first
	if (v.frm && (v.frm !== 'lite' || liveAvailable.value) && (v.frm !== 'full' || octreeAvailable.value)) chooseMode(v.frm);
	if (v.mode) chartMode.value = v.mode;
	if (v.axis) axis.value = v.axis;
	if (v.zSeries) zSeries.value = v.zSeries;
	if (v.compare) {
		for (const id of v.compare) {
			const row = rows.value.find((r) => r.id === id);
			if (row && id !== selectedRowId.value) await addCompare(row);
		}
	}
	if (v.reference && compareIds.value.includes(v.reference)) { compareRefId.value = v.reference; diffOn.value = !!v.diff; }
	await nextTick();   // chartMode/op changes reset the zoom; set it after
	if (v.zoom) { zoomStart.value = v.zoom[0]; zoomEnd.value = v.zoom[1]; }
	if (v.scale) {
		colorScale.value = withAutoRange(colorScale.value, v.scale[0], v.scale[1]);
		locked.value = true;
	}
	const opId = detail.value?.id;
	if (v.crop && opId) {
		// The crop handles are re-seeded from the cache when it parses (onCloudLoaded), which may
		// land after this. Apply now, but keep the request until that op's load has re-applied it.
		pendingCrop.set(opId, v.crop);
		applyPendingCrop(pendingCrop.peek(opId));
	}
}
function applyPendingCrop(crop: [number, number] | null) {
	if (!crop) return;
	cropStartSec.value = crop[0]; cropEndSec.value = crop[1];
}

// Selected axes for a panel (spectral views render one SpectrumView per axis, like the force plot).
function axesFor(item: RPanel): Axis[] {
	const sel = (item.channels && item.channels.length ? item.channels : AXES) as readonly Axis[];
	return AXES.filter((a) => sel.includes(a));
}
// Chain the spectral views reflect: the live-tuned/applied filter when present, else raw.
const specChain = computed<FilterChain>(() => previewChain() ?? savedChain.value ?? defaultChain());
function toggleItemAxis(item: RPanel, a: Axis) {
	// Every mode (Force/FFT/Power/Spectrogram/Waterfall) draws one chart per selected axis,
	// stacked in the panel — SpectrumView labels each with its axis name (e.g. "Fx spectrogram"),
	// same as ForceChart's title, so stacked heatmaps are just as distinguishable as stacked
	// line charts. Toggling works the same in every mode.
	const cur = (item.channels && item.channels.length ? [...item.channels] : [...AXES]);
	const i = cur.indexOf(a);
	if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); } else cur.push(a);
	item.channels = AXES.filter((x) => cur.includes(x));
}

// Seed the editable controls from the loaded cache (FrmCloud emits this once the
// binary is parsed). User edits thereafter drive the cloud; Reset restores these.
function onCloudLoaded(meta: { csSec: number; ceSec: number; feed: number; diam: number; rpm: number; Fs: number; N: number }) {
	// A human-saved override beats the cache's own auto-detected csSec/ceSec (the cache was baked
	// before the correction, so its header is stale) — same "override beats cache header" rule as
	// the diameter below. Absent an override, the cache's crop is the best available.
	if (savedCropSec.value) { cropStartSec.value = savedCropSec.value.start; cropEndSec.value = savedCropSec.value.end; }
	else { cropStartSec.value = meta.csSec; cropEndSec.value = meta.ceSec; }
	applyPendingCrop(pendingCrop.take(detail.value?.id));   // a shared link's crop preview beats the cache's own window
	editFeed.value = cleanFloat(meta.feed);
	editDiam.value = cleanFloat(meta.diam);
	const od = Number(detail.value?.outer_diameter);
	if (od > 0) editDiam.value = od;   // per-op override beats the cache header
	editRpm.value = meta.rpm;
	editRate.value = meta.Fs;
	cacheFs = meta.Fs;
	speedMode.value = 'measured';
	// derive a sensible Vc default from the measured mean speed + diameter
	editVc.value = Math.round(Math.PI * meta.diam * meta.rpm / 1000) || 100;
	// the cache's feed/diam/rate are the "source" for the modified-highlight in Live
	srcCut.feed = editFeed.value; srcCut.diam = editDiam.value; srcCut.rate = editRate.value;
	cacheEpoch.value++;   // the cache just landed in the LRU — let radialValuesFor() see it
}

// ---- Second X-axis (radial tool position) on the time-series charts ------------------------
// 'measured' speed mode needs the cache's baked revs_cum, so it may require an on-demand fetch
// (see fetchRadialCache); 'rpm'/'vc' modes are closed-form in elapsed time alone and never do.
// The radial second X-axis is always on now (its old 'none'/'radial' picker is gone). It used to
// default to 'none' because turning it on fetches a multi-MB cache asset, which wanted to be an
// explicit user action -- that fetch is still lazy (measuredRadialSpan below only calls
// fetchRadialCache when the LRU misses, and Lite mode has usually already put it there), it just
// no longer waits for a click.
const radialFetchBusy = ref(false);
async function fetchRadialCache() {
	const d = detail.value;
	if (!d?.live_cache_file || radialFetchBusy.value || cacheGet(d.live_cache_file)) return;
	radialFetchBusy.value = true;
	try {
		const res = await api.get(`/assets/${d.live_cache_file}`, { responseType: 'arraybuffer' });
		cachePut(d.live_cache_file, parseCache(res.data as ArrayBuffer));
		cacheEpoch.value++;
	} catch { /* leave the second axis blank until the user retries (e.g. reselecting the field) */ }
	finally { radialFetchBusy.value = false; }
}
// ---- Linking the FRM map and the Signals charts -------------------------------------------------
// Time is the shared key: the charts plot envelope buckets of detail.series[a].t, the maps plot
// cache samples, and idxOfTime() converts between them (see cloudPick.ts). markTime is the pinned
// sample (marker line on the charts + ring on the map); hoverTime is the transient chart hover.
// Neither is persisted, and there is no new panel type (RIGHT_KEY and saved layouts untouched).
const markTime = ref<number | null>(null);
const menu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
const helpOpen = ref(false);
const linkMsg = ref('');
let linkMsgTimer = 0;
function flashLinkMsg(m: string) {
	linkMsg.value = m;
	clearTimeout(linkMsgTimer);
	linkMsgTimer = window.setTimeout(() => { linkMsg.value = ''; }, 2500);
}
// The shared time base of the envelope charts (every axis has the same bucket times).
const envTimes = computed<ArrayLike<number> | null>(() => {
	const s = detail.value?.series;
	const t = (s?.[axis.value] ?? s?.Fz ?? s?.Fx ?? s?.Fy)?.t;
	return t && t.length ? t : null;
});
// hoverIndex is a bucket index into the env series in Force mode only (in FFT it is a frequency bin).
const hoverTime = computed<number | null>(() => {
	const i = hoverIndex.value;
	const t = envTimes.value;
	if (i == null || chartMode.value !== 'force' || !t || i < 0 || i >= t.length) return null;
	return t[i];
});
// The octree has no time attribute, so it is picked by position against the live cache's own path
// (cloudPick.ts). Reuses the lazy loader of the measured-mode radial axis, so in practice the
// cache is already in the LRU from Lite.
const octreeSampleCache = computed<Cache | null>(() => {
	void cacheEpoch.value;
	const id = detail.value?.live_cache_file;
	if (!id || !octreeOn.value) return null;
	const c = cacheGet(id);
	if (!c) fetchRadialCache();
	return c ?? null;
});
// A reveal for a map that is still loading is queued inside the map component itself (it applies
// it after its first draw with content), so the dashboard only handles a definite "no such point".
watch(selectedRowId, () => { markTime.value = null; menu.value = null; });
function onLinkKey(e: KeyboardEvent) {
	// defaultPrevented: the open ContextMenu consumed this Escape (it closes itself and preventDefaults),
	// and `menu` may already be null by the time we run, so the flag is the reliable signal.
	if (e.key !== 'Escape' || e.defaultPrevented || menu.value || markTime.value == null) return;
	const el = document.activeElement as HTMLElement | null;
	if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
	markTime.value = null;
}
// This page is kept alive (#24): onMounted runs once, so the listener is also dropped on deactivate
// (Escape on the Record page must not reach us) and re-added on activate. addEventListener ignores a
// second registration of the same function, so onMounted + onActivated can't double up.
function addLinkKey() { window.addEventListener('keydown', onLinkKey); }
function removeLinkKey() { window.removeEventListener('keydown', onLinkKey); }
onMounted(addLinkKey);
onActivated(addLinkKey);
onDeactivated(removeLinkKey);
onBeforeUnmount(() => { removeLinkKey(); clearTimeout(linkMsgTimer); });

function openMenu(x: number, y: number, items: ContextMenuItem[]) { menu.value = { x, y, items }; }
function clearMarkItem(): ContextMenuItem[] {
	return markTime.value != null ? [{ label: 'Clear marker', run: () => { markTime.value = null; } }] : [];
}
// Crop edges go through onCropEdit, so they batch into Save changes like a handle drag; refuse an
// edge that would cross the other one.
function cropItems(t: number | null): ContextMenuItem[] {
	const noT = t == null;
	const startCross = !noT && cropEndSec.value > 0 && t >= cropEndSec.value;
	const endCross = !noT && t <= cropStartSec.value;
	return [
		{ label: 'Set crop start here', disabled: noT || startCross, hint: startCross ? 'Would cross the crop end' : undefined,
			run: () => { if (t != null) onCropEdit('start', t); } },
		{ label: 'Set crop end here', disabled: noT || endCross, hint: endCross ? 'Would cross the crop start' : undefined,
			run: () => { if (t != null) onCropEdit('end', t); } },
	];
}
function openPointMenu(e: PointMenuEvent) {
	const p = e.point;
	const hint = p ? undefined
		: e.reason === 'gridded' ? 'Gridded 3D view averages samples'
		: e.reason === 'no-cache' ? 'Needs this cut’s live cache'
		: e.reason === 'outside-cache' ? 'The live cache doesn’t cover this octree’s crop'
		: e.reason === 'loading' ? 'The map is still loading'
		: 'No point under the cursor';
	const items: ContextMenuItem[] = [
		{ label: 'Show position in time', disabled: !p, hint, run: () => { if (p) showInTime(p.t); } },
		...clearMarkItem(),
		{ label: 'Copy point info', disabled: !p, hint, run: () => { if (p) copyPointInfo(p); } },
		...cropItems(p ? p.t : null).map((it) => (p ? it : { ...it, hint })),
	];
	openMenu(e.clientX, e.clientY, items);
}
async function showInTime(t: number) {
	if (chartMode.value !== 'force') chartMode.value = 'force';   // the existing watch resets the zoom
	markTime.value = t;
	await nextTick();
	const ts = envTimes.value;
	if (!ts) return;
	const w = recentreWindow(zoomStart.value, zoomEnd.value, t, ts[0], ts[ts.length - 1]);
	if (w) onChartZoom(w);
}
async function copyPointInfo(p: PointInfo) {
	try {
		if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
		await navigator.clipboard.writeText(formatPointInfo(p));
		flashLinkMsg('Point info copied');
	} catch { flashLinkMsg('Copy failed — clipboard unavailable'); }
}
function chartImageItems(snap: () => ChartSnapshot): ContextMenuItem[] {
	const save = async (format: 'png' | 'svg') => {
		const s = snap();
		const modeLabel = CHART_MODES.find((m) => m.key === chartMode.value)?.label ?? chartMode.value;
		const ok = await saveChartImage({ ...s, opLabel: opLabel.value, subtitle: `${modeLabel} mode` }, format,
			`${safeFilePart(opLabel.value) || 'op'}_${safeFilePart(s.title) || 'chart'}`);
		flashLinkMsg(ok ? `Chart saved as ${format.toUpperCase()}` : `Could not save the chart as ${format.toUpperCase()}`);
	};
	return [
		{ label: 'Save chart as PNG', run: () => { void save('png'); } },
		{ label: 'Save chart as SVG', run: () => { void save('svg'); } },
	];
}
function openChartMenu(e: { clientX: number; clientY: number; x: number | null; snapshot: () => ChartSnapshot }) {
	const images = chartImageItems(e.snapshot);
	const t = e.x;
	if (t == null) { openMenu(e.clientX, e.clientY, images); return; }   // a spectrum: no map position
	let hint: string | undefined;
	if (octreeOn.value) {
		const c = octreeSampleCache.value;
		if (!detail.value?.live_cache_file) hint = 'Needs this cut’s live cache';
		// A time outside the mappable window (the octree's build window within the live cache) has no
		// mapped sample. The map knows that window (the build manifest): null means nothing can be
		// mapped; undefined means it isn't known yet, and the cache's own range stands in. With the
		// cache still loading we can't say, so the item stays enabled (the map queues the reveal).
		else if (c && c.N) {
			const w = frmOctreeRef.value?.timeWindow?.() as { start: number; end: number } | null | undefined;
			if (w === null) hint = 'The live cache doesn’t cover this octree’s crop';
			else if (w ? (t < w.start || t > w.end) : (t < c.t[0] || t > c.t[c.N - 1])) hint = 'Outside the mapped window';
		}
	}
	else if (liveAvailable.value) {
		// A zero-width crop means the crop isn't loaded/seeded yet (both edges 0), not "nothing is inside".
		if (cropEndSec.value > cropStartSec.value && (t < cropStartSec.value || t > cropEndSec.value)) hint = 'Outside the cropped window';
	}
	else hint = 'No interactive map for this cut';
	openMenu(e.clientX, e.clientY, [
		{ label: 'Show position on map', disabled: !!hint, hint, run: () => showOnMap(t) },
		...clearMarkItem(),
		...cropItems(t),
		...images,
	]);
}
async function showOnMap(t: number) {
	markTime.value = t;
	if (!octreeOn.value && !liveOn.value) chooseMode('lite');   // the Figure PNG can't show a ring
	await nextTick();
	// false = no drawn sample for t (a map still loading queues the reveal itself and says true)
	const map = (octreeOn.value ? frmOctreeRef : frmCloudRef).value;
	if (!map?.revealTime?.(t)) flashLinkMsg('No mapped point at this time');
}
// Memoized once per (op, geometry, crop, cache-arrival) rather than recomputed per axis per
// render: chartsFor() calls radialValuesFor() once per open axis (+ RPM), so without this,
// dragging the mouse (hoverIndex re-renders every open chart, see the Phase-1.3 rAF fix) would
// re-run the O(N) scan 3-4x per animation frame. rho is axis-independent (a function of time
// only), so one span serves every axis + RPM chart in the panel. It is a span (where the spiral
// starts and stops), not a built path: buildPath() allocated ~100 MB at 5M points on every
// crop-handle drag only for alignRhoToBuckets to read rho back out of it (review 3.10).
const measuredRadialSpan = computed(() => {
	if (speedMode.value !== 'measured') return null;
	const d = detail.value;
	const cropStart = activeCrop.value?.start;
	if (!d?.live_cache_file || cropStart == null) return null;
	void cacheEpoch.value;
	const c = cacheGet(d.live_cache_file);
	if (!c) { fetchRadialCache(); return null; }
	const p: TurningSpiralParams = {
		kind: 'turning_spiral', feed: editFeed.value, diam: editDiam.value, innerDiam: editInnerDiam.value,
		speedMode: 'measured', rpm: editRpm.value, vc: editVc.value, timeScale: timeScale.value, ppr: editPpr.value,
	};
	return { c, span: measuredRhoSpan(c, p, cropStart) };
});
// bucketT: the chart's own x-axis time array (d.series[a].t) — a full-range, uncropped envelope,
// same as what cropStart/cropEnd shade a sub-window of. Radial position is only meaningful from
// the crop start onward (r=0 there, matching path.ts's buildTurningSpiral); earlier bucket times
// get NaN, same as any time past wherever the spiral stops (cut-out / inner-diameter reached).
function radialValuesFor(bucketT: number[] | Float32Array | undefined): Float32Array | null {
	if (!bucketT || !bucketT.length) return null;
	const cropStart = activeCrop.value?.start;
	if (cropStart == null) return null;
	const rho0 = editDiam.value / 2;
	const innerR = Math.max(0, (editInnerDiam.value || 0) / 2);
	if (speedMode.value === 'measured') {
		const m = measuredRadialSpan.value;
		if (!m?.span) { const out = new Float32Array(bucketT.length); out.fill(NaN); return out; }
		return alignMeasuredRho(m.span, m.c, bucketT);
	}
	const out = new Float32Array(bucketT.length);
	if (speedMode.value === 'rpm') {
		const revPerSec = editRpm.value / 60;
		for (let i = 0; i < bucketT.length; i++) {
			if (bucketT[i] < cropStart) { out[i] = NaN; continue; }
			const rho = rho0 - editFeed.value * (revPerSec * (bucketT[i] - cropStart) * timeScale.value);
			out[i] = rho < innerR ? NaN : rho;
		}
	} else {   // vc
		const K = editFeed.value * editVc.value * 1000 / (Math.PI * 120);
		for (let i = 0; i < bucketT.length; i++) {
			if (bucketT[i] < cropStart) { out[i] = NaN; continue; }
			const under = rho0 * rho0 - 2 * K * (bucketT[i] - cropStart) * timeScale.value;
			out[i] = under < innerR * innerR ? NaN : Math.sqrt(under);
		}
	}
	return out;
}

function resetLive() {
	const d = detail.value;
	pendingCrop.clear();   // Reset restores the cache's window; a link's crop request must not re-apply over it
	if (cropWindow.value) { cropStartSec.value = cropWindow.value.start; cropEndSec.value = cropWindow.value.end; cropTouched.value = true; }
	if (d) {
		editFeed.value = Number(d.feed) || editFeed.value;
		editDiam.value = Number(d.outer_diameter) || Number(d.cut_diameter) || editDiam.value;
		editInnerDiam.value = Number(d.inner_diameter) || 0;
		editRate.value = Number(d.sample_rate) || editRate.value;
		editPpr.value = Number(d.pulses_per_rev) || 1;
	}
	speedMode.value = 'measured';
	plotStride.value = 1; gridding.value = false; pointSize.value = 1.4;
	// Renderers dedupe their climits, so nothing would re-seed a blank scale: rebuild it from the
	// current auto range instead of defaultScale(0, 1).
	const r = currentAuto.value;
	colorScale.value = r ? defaultScale(r[0], r[1]) : defaultScale(0, 1);
	locked.value = false;
}
// Rate override rescales time for the constant-RPM/Vc models (measured mode uses the
// baked revs, so it's unaffected). timeScale = 1 when Rate is left at the cache's Fs.
const timeScale = computed(() => (editRate.value > 0 ? cacheFs / editRate.value : 1));

// Tier 2: ask the host to regenerate the cache at a finer resolution (down to 1:1).
async function processFullRes() {
	const d = detail.value;
	if (!d?.id || rendering.value) return;
	const live = opGuard.begin(d.id);
	rendering.value = true;
	renderMsg.value = 'Requesting host render…';
	try {
		await api.patch(`/items/machining_force_analysis/${d.id}`, {
			status: 'pending', live_render_points: Math.max(1, Math.round(renderPoints.value)),
		});
		if (!live()) return;
		renderMsg.value = 'Queued — waiting for the host crawler…';
		await pollRender(d.id, d.live_cache_file, live);
	} catch (e: any) {
		if (!live()) return;
		renderMsg.value = e?.response?.status === 403
			? 'Not permitted (admin only) to request a host render.'
			: (e?.message || 'render request failed');
	} finally {
		if (live()) rendering.value = false;
	}
}
async function pollRender(id: string, prevCacheId: string | null, live: () => boolean) {
	const deadline = Date.now() + 5 * 60 * 1000;         // give the host up to 5 min
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2500));
		if (!live()) return;
		let row: any = null;
		try {
			const res = await api.get(`/items/machining_force_analysis/${id}`, { params: { fields: ['status', 'live_cache_file', 'live_render_points', 'error_message'] } });
			row = res.data?.data;
		} catch { /* transient */ }
		if (!live()) return;
		if (!row) continue;
		if (row.status === 'error') { renderMsg.value = `Host render failed: ${row.error_message || 'unknown error'}`; return; }
		if (row.status === 'done' && !row.live_render_points) {
			renderMsg.value = 'Rendered at requested resolution.';
			if (detail.value && detail.value.id === id) detail.value = { ...detail.value, live_cache_file: row.live_cache_file };
			return;
		}
	}
	renderMsg.value = 'Still processing on the host — check back shortly.';
}

// The record editors live in Directus admin. How to get there differs per environment
// (in-app router.push inside the admin module; a new tab from the standalone app), so
// the host adapter owns the navigation.
function openSampleForm() { if (sampleInfo.value?.id) host.openRecord('physical_samples', String(sampleInfo.value.id)); }
function openOpForm() { if (op.value?.operation_id) host.openRecord('manufacturing_operations', String(op.value.operation_id)); }

function fmt(v: any): string {
	if (v == null || v === '') return '—';
	const n = Number(v);
	return Number.isFinite(n) ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)) : '—';
}
// Strip float32 round-trip noise (the live cache stores feed/diam as float32, so they
// read back as 0.10000000149… ). toPrecision(6) collapses that to 0.1 while KEEPING
// genuine sub-values like 0.017 — so this is safer than a blunt toFixed(2), which would
// wrongly flatten 0.017 → 0.02.
function cleanFloat(v: any): number {
	const n = Number(v);
	return Number.isFinite(n) ? parseFloat(n.toPrecision(6)) : (v as number);
}
function fmtDate(v: string) {
	return v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}
// Asset auth differs per environment (same-origin cookie in Directus, cross-origin Bearer
// standalone), so the host adapter owns the actual download.
function downloadFile(fileId: string) { void host.downloadAsset(fileId); }

// "Download this FRM image": in an interactive view (live cloud or octree) export the CURRENT
// viewport — whatever zoom/pan is on screen — straight from the canvas. Only the static image
// view (no interactive renderer) falls back to the precomputed full-scale PNG.
const frmOctreeRef = ref<any>(null);
function downloadFrm() {
	const d = detail.value;
	if (!d) return;
	const label = String((opLabel.value && opLabel.value !== '—') ? opLabel.value : (d.operation_code || d.operation_id || d.id));
	const name = `FRM_${axis.value}_${label}.png`;
	if (octreeOn.value && frmOctreeRef.value?.exportViewport) { if (frmOctreeRef.value.exportViewport(name, label)) return; }
	if (liveOn.value && frmCloudRef.value?.exportViewport) { if (frmCloudRef.value.exportViewport(name, label)) return; }
	const f = d[`frm_${axis.value.toLowerCase()}`];
	if (f) downloadFile(f);
}

// Template ref to the live cloud, used by downloadFrm() to export the current viewport.
const frmCloudRef = ref<any>(null);
// The .mat file's own metadata.TriggerTime, when present — the actual recording
// time, as distinct from operation_date (often just the sample record's creation
// time for legacy imports).
function fmtDateTime(v: string | null | undefined) {
	if (!v) return '';
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
	<private-view title="Force Analysis">
		<div class="fd" :class="{ dense: host.dense }" @click="rightAddOpen = false">
			<section class="hero">
				<span class="hero-badge"><v-icon name="insights" x-small /> Force Analysis</span>
				<span class="hero-stat">{{ rows.length }} op{{ rows.length === 1 ? '' : 's' }} · {{ samples.length }} sample{{ samples.length === 1 ? '' : 's' }}</span>
				<div class="hero-spacer"></div>
				<div class="panel-toggles" @click.stop>
					<span class="pt-label">Panels</span>
					<!-- Add + each panel's own close is the whole panel menu (as on the Record page). Eye
						 toggles for Signals and FRM map used to sit here too, a third way to do the same. -->
					<div class="pt-add">
						<button class="pt-chip" title="Add a panel" @click.stop="rightAddOpen = !rightAddOpen"><v-icon name="add" x-small /> Add</button>
						<div v-if="rightAddOpen" class="pt-menu" @click.stop>
							<button @click="addRightPanel('signals')"><v-icon name="insights" x-small /> Signals</button>
							<button @click="addRightPanel('frm')"><v-icon name="fingerprint" x-small /> FRM map</button>
							<button @click="addRightPanel('wear')"><v-icon name="trending_up" x-small /> Wear trend</button>
							<button @click="addRightPanel('doctor')"><v-icon name="health_and_safety" x-small /> Metadata doctor</button>
						</div>
					</div>
					<button class="pt-chip" title="Reset panel layout" @click="resetRightLayout"><v-icon name="grid_view" x-small /></button>
					<button class="pt-chip" title="Gestures and shortcuts" aria-label="Help: gestures and shortcuts" aria-haspopup="dialog" @click="helpOpen = true">?</button>
					<button class="pt-chip" title="Copy a link that reopens this view (cut, mode, axes, zoom, compare set)" :disabled="!selectedRowId" @click="copyViewLink">
						<v-icon name="link" x-small /> {{ linkCopied ? 'Copied' : linkCopyFailed ? 'Copy failed' : 'Copy link' }}
					</button>
				</div>
			</section>

			<div v-show="loading" class="loading"><v-progress-circular indeterminate /></div>

			<div v-show="!loading" ref="layoutEl" class="layout" :class="{ dragging, stacked }"
				:style="{ gridTemplateColumns: gridCols, height: stacked ? 'auto' : availableHeight + 'px' }">
				<!-- COL 1: samples + operations (collapsible away to the right) -->
				<div v-if="stacked || !colStackHidden" class="col-stack">
					<div class="panel panel-samples">
						<div class="panel-head"><v-icon name="science" small /><span>Samples</span><span class="chip">{{ filteredSamples.length }}</span>
							<button v-if="!stacked" class="collapsebtn" title="Hide the samples/operations column" @click="colStackHidden = true"><v-icon name="chevron_left" x-small /></button>
						</div>
						<input v-model="sampleSearch" class="search" placeholder="Search samples…" />
						<div class="list">
							<button v-for="s in filteredSamples" :key="s.sample_id"
								class="rowcard" :class="{ active: selectedSampleId === s.sample_id }" @click="selectSample(s)">
								<span class="mono">{{ s.sample_code }}</span>
								<span class="sub">{{ s.material || '—' }}<template v-if="s.nickname"> · {{ s.nickname }}</template></span>
								<span class="pill">{{ s.ops.length }} op{{ s.ops.length === 1 ? '' : 's' }}</span>
							</button>
							<div v-if="!filteredSamples.length" class="empty">No samples</div>
						</div>
					</div>

					<div class="panel panel-ops">
						<div class="panel-head">
							<v-icon name="build" small /><span>Operations</span><span class="chip">{{ displayedOps.length }}</span>
							<button v-if="filterSampleId" class="clearbtn" @click="filterSampleId = null">all</button>
						</div>
						<input v-model="opSearch" class="search" placeholder="Search operations…" />
						<!-- Metadata Doctor filter. Separate from the plot-readiness dot: this one is about
						     whether the .mat and D1 agree, which is a different question. -->
						<label v-if="doctorFlaggedCount" class="doc-filter">
							<input v-model="issuesOnly" type="checkbox" />
							<span>Metadata issues only</span>
							<span class="chip">{{ doctorFlaggedCount }}</span>
						</label>
						<div class="list">
							<button v-for="o in displayedOps" :key="o.id"
								class="rowcard" :class="{ active: selectedRowId === o.id }" @click="selectOp(o)">
								<span class="mono sm"><span class="qdot" :class="frmQuality(o).level" :title="frmQuality(o).label"></span>{{ o.operation_id?.pass_code || '—' }}
									<span v-if="doctorQuality(o)" class="docdot" :class="doctorQuality(o)!.level"
										:title="`Metadata: ${doctorQuality(o)!.label}`">{{ doctorQuality(o)!.count }}</span>
									<span v-if="o.id === latestRowId" class="latest-chip" title="The most recently saved recording">
										<v-icon name="bolt" x-small />Latest
									</span>
								</span>
								<span class="sub">
									<template v-if="!filterSampleId">{{ sampleOf(o)?.sample_code }} · </template>
									{{ fmtDate(o.operation_id?.operation_date) }}
								</span>
								<span class="badge" :style="{ background: AXIS_COLOR.Fz }">Fz {{ fmt(o.peak_fz) }} N</span>
							</button>
							<div v-if="!displayedOps.length" class="empty">No operations</div>
						</div>
					</div>
				</div>

				<div v-if="!stacked && !colStackHidden" class="resizer" @pointerdown="startColAResize" title="Drag to resize"></div>

				<!-- COL 2: sample detail + operation detail (foldable away to the left) -->
				<div v-if="stacked || !detailHidden" class="col-stack" :class="{ switching: loadingDetail }" :aria-busy="loadingDetail" :inert="loadingDetail">
					<div class="card info" :class="{ collapsed: !sampleDetailOpen }">
						<div class="info-head">
							<span>
								<button class="chevbtn" title="Collapse/expand" @click="sampleDetailOpen = !sampleDetailOpen"><v-icon :name="sampleDetailOpen ? 'expand_more' : 'chevron_right'" x-small /></button>
								<v-icon name="science" x-small /> Sample detail
							</span>
							<span class="ih-actions">
								<button v-if="sampleInfo?.id" class="openbtn" @click="openSampleForm">Open <v-icon name="open_in_new" x-small /></button>
								<button v-if="!stacked" class="collapsebtn" title="Hide the detail column" @click="detailHidden = true"><v-icon name="chevron_left" x-small /></button>
							</span>
						</div>
						<template v-if="sampleDetailOpen">
							<template v-if="sampleInfo">
								<div class="info-code mono">{{ sampleInfo.sample_code }}</div>
								<div class="kv">
									<span>Material</span><span>{{ sampleInfo.material || '—' }}</span>
									<span>Nickname</span><span>{{ sampleInfo.nickname || '—' }}</span>
									<template v-if="sampleInfo.form"><span>Form</span><span>{{ sampleInfo.form }}</span></template>
									<span>Owner</span><span>{{ sampleInfo.owner || '—' }}</span>
									<template v-if="sampleInfo.manufactured"><span>Made</span><span>{{ fmtDate(sampleInfo.manufactured) }}</span></template>
									<span>Analysed ops</span><span>{{ sampleInfo.ops ?? '—' }}</span>
								</div>
							</template>
							<div v-else class="empty sm">Select a sample or operation</div>
						</template>
					</div>

					<div class="card info info-op" :class="{ collapsed: !opDetailOpen }">
						<div class="info-head">
							<span>
								<button class="chevbtn" title="Collapse/expand" @click="togglePanel('detail')"><v-icon :name="opDetailOpen ? 'expand_more' : 'chevron_right'" x-small /></button>
								<v-icon name="build" x-small /> Operation detail
							</span>
							<button v-if="op?.operation_id" class="openbtn" @click="openOpForm">Open <v-icon name="open_in_new" x-small /></button>
						</div>
						<template v-if="detail && opDetailOpen">
							<div class="info-code mono">{{ opLabel }}</div>
							<div v-if="compactMeta.length" class="kv">
								<template v-for="m in compactMeta" :key="m[0]"><span>{{ m[0] }}</span><span>{{ m[1] }}</span></template>
							</div>

							<!-- Editable operation metadata: Subtype/New edge/Coolant/Operator/cutting params/
							     notes. Machine/Method stay read-only above (see opMeta). Sequence and Operation
							     code are shown here for context but are NOT editable: Operation code is purely
							     a derived consequence of the fields around it, and Sequence is the key archive
							     .mat filenames are matched to an operation by, so hand-editing either from this
							     panel would silently desync that link (see regeneratedPassCode above). Combined
							     with any pending crop edit into one "Save changes" summary dialog below. -->
							<!-- Surface speed / Feed / Depth of cut / Workpiece Ø appear again under "Cut
							     parameters" below, which reads as a duplicate until you know these two
							     groups are different RECORDS: this one is the operation as specified
							     (manufacturing_operations), that one is what this capture actually used
							     (machining_force_analysis, and the source of the spiral geometry). The
							     headings now say which is which. -->
							<div class="stat-sep">Operation record <span class="u">(as specified)</span>
								<button v-if="metaDirty" class="linkbtn" @click="seedMetaFromDetail">Reset</button>
							</div>
							<div class="edit-grid">
								<label>Subtype<input v-model="editOpSubtype" type="text" :class="{ modified: editOpSubtype !== srcMeta.subtype }" /></label>
								<label>Sequence<input :value="fmtOrDash(srcMeta.sequence)" type="text" disabled title="Derived — matches the archive .mat filename this operation was linked from. Not editable here." /></label>
								<!-- Unit inside the field, right of the number, matching the Record page's
								     .unit-box: folded into the label it wrapped these two-word labels onto a
								     second line in this narrow column, which cost a row of height per field. -->
								<label>Surface speed
									<span class="unit-box"><input v-model.number="editOpCuttingSpeed" type="number" step="0.1" min="0" :class="{ modified: numDiffers(numOrNull(editOpCuttingSpeed), srcMeta.cuttingSpeed) }" /><span class="unit">m/min</span></span>
								</label>
								<label>Feed
									<span class="unit-box"><input v-model.number="editOpFeedMmPerRev" type="number" step="0.001" min="0" :class="{ modified: numDiffers(numOrNull(editOpFeedMmPerRev), srcMeta.feedMmPerRev) }" /><span class="unit">mm/rev</span></span>
								</label>
								<label>Depth of cut
									<span class="unit-box"><input v-model.number="editOpAxialDoc" type="number" step="0.01" min="0" :class="{ modified: numDiffers(numOrNull(editOpAxialDoc), srcMeta.axialDoc) }" /><span class="unit">mm</span></span>
								</label>
								<!-- The operation's recorded stock diameter — distinct from the FRM "Diameter"
								     control above (machining_force_analysis.outer_diameter, a spiral-geometry
								     override). Editable so the Doctor's diameter backfill has somewhere to write. -->
								<label>Workpiece Ø
									<span class="unit-box"><input v-model.number="editOpWorkpieceDiam" type="number" step="0.1" min="0" :class="{ modified: numDiffers(numOrNull(editOpWorkpieceDiam), srcMeta.workpieceDiam) }" /><span class="unit">mm</span></span>
								</label>
								<label>Operator<input v-model="editOperatorName" type="text" :class="{ modified: editOperatorName !== srcMeta.operator }" /></label>
								<label class="chk">New edge<input v-model="editOpNewEdge" type="checkbox" /></label>
								<label class="chk">Coolant<input v-model="editOpCoolant" type="checkbox" /></label>
								<label class="wide">Operation code
									<input :value="regeneratedPassCode || fmtOrDash(srcMeta.passCode)" type="text" disabled :class="{ modified: !!regeneratedPassCode && regeneratedPassCode !== srcMeta.passCode }" title="Derived from Subtype/Sequence/cutting params + the sample code. Not editable here." />
								</label>
								<label class="wide">Notes<textarea v-model="editOutcomeNotes" rows="2" :class="{ modified: editOutcomeNotes !== srcMeta.outcomeNotes }"></textarea></label>
							</div>
							<button v-if="hasChanges" class="crop-save" @click="changesDialogOpen = true">Save changes</button>

							<!-- Editable cut-parameter boxes (Feed/Diameter/Inner Ø/PPR): drive the Live plot
							     and are threaded into any host bake. Measured values stay read-only. A box is
							     highlighted when its value differs from what the op was loaded with. -->
							<div class="stat-sep">Cut parameters <span class="u">(this capture — draws the fingerprint)</span>
								<button v-if="!near(editFeed, srcCut.feed) || !near(editDiam, srcCut.diam) || !near(editInnerDiam, srcCut.inner) || !near(editPpr, srcCut.ppr)"
									class="linkbtn" @click="seedCutFromDetail">Reset</button>
							</div>
							<div class="statgrid">
								<div class="stat edit" :class="{ modified: !near(editFeed, srcCut.feed) }">
									<div class="s-top"><input class="s-inp" v-model.number="editFeed" type="number" step="0.01" min="0" /><span class="s-unit">mm/rev</span></div>
									<span class="s-lab">Feed</span>
								</div>
								<div class="stat edit" :class="{ modified: !near(editDiam, srcCut.diam) }">
									<div class="s-top"><input class="s-inp" v-model.number="editDiam" type="number" step="1" min="0" /><span class="s-unit">mm</span></div>
									<span class="s-lab">Diameter</span>
								</div>
								<div class="stat edit" :class="{ modified: !near(editInnerDiam, srcCut.inner) }">
									<div class="s-top"><input class="s-inp" v-model.number="editInnerDiam" type="number" step="1" min="0" title="Donut/diaphragm inner diameter — the spiral stops here. 0 = solid disc." /><span class="s-unit">mm</span></div>
									<span class="s-lab">Inner Ø</span>
								</div>
								<div class="stat edit" :class="{ modified: !near(editPpr, srcCut.ppr) }">
									<div class="s-top"><input class="s-inp" v-model.number="editPpr" type="number" step="1" min="1" /></div>
									<span class="s-lab">Pulses/rev</span>
								</div>
								<div v-if="addsInfoOverOp(detail.surface_speed, srcMeta.cuttingSpeed)" class="stat mismatch"><div class="s-top"><span class="s-val">{{ fmt(detail.surface_speed) }}</span><span class="s-unit">m/min</span></div><span class="s-lab">Surface speed <span class="u">(capture)</span></span></div>
								<div v-if="addsInfoOverOp(detail.depth_of_cut, srcMeta.axialDoc)" class="stat mismatch"><div class="s-top"><span class="s-val">{{ fmt(detail.depth_of_cut) }}</span><span class="s-unit">mm</span></div><span class="s-lab">Depth of cut <span class="u">(capture)</span></span></div>
								<div class="stat edit" :class="{ modified: !near(editRate, srcCut.rate) }">
									<div class="s-top"><input class="s-inp" v-model.number="editRateKHz" type="number" step="0.1" min="0.1" /><span class="s-unit">kHz</span></div>
									<span class="s-lab">Capture</span>
								</div>
								<div class="stat"><div class="s-top"><span class="s-val">{{ fmtCutTime(detail) }}</span></div><span class="s-lab">Cut time</span></div>
							</div>

							<template v-if="liveOn">
								<div class="stat-sep">Plot model <span class="u">(what-if — plot only)</span> <button class="linkbtn" @click="resetLive">Reset</button></div>
								<div class="edit-grid">
									<label class="wide">Spindle speed
										<div class="speed-row">
											<select v-model="speedMode">
												<option value="measured">Measured (tacho)</option>
												<option value="rpm">Constant RPM</option>
												<option value="vc">Constant Vc</option>
											</select>
											<input v-if="speedMode === 'rpm'" v-model.number="editRpm" type="number" step="10" min="1" title="RPM" />
											<input v-if="speedMode === 'vc'" v-model.number="editVc" type="number" step="1" min="1" title="Vc (m/min)" />
										</div>
									</label>
								</div>
							</template>

							<button class="acc-head" @click="captureOpen = !captureOpen">
								<v-icon :name="captureOpen ? 'expand_more' : 'chevron_right'" x-small /> Capture
							</button>
							<div v-if="captureOpen && captureInfo.length" class="kv">
								<template v-for="m in captureInfo" :key="m[0]"><span>{{ m[0] }}</span><span>{{ m[1] }}</span></template>
							</div>
						</template>
						<div v-else-if="opDetailOpen && loadingDetail" class="loading sm"><v-progress-circular indeterminate small /></div>
						<div v-else-if="opDetailOpen && !detail" class="empty sm">Select an operation</div>
					</div>

					<!-- Display: appearance of the FRM plot (colour map / point size / colour limits /
					     thinning) + the on-demand host full-res render. Its own accordion so it isn't
					     buried inside the operation detail. -->
					<div v-if="detail" class="card info info-display" :class="{ collapsed: !displayPanelOpen }">
						<div class="info-head">
							<span>
								<button class="chevbtn" title="Collapse/expand" @click="togglePanel('display')"><v-icon :name="displayPanelOpen ? 'expand_more' : 'chevron_right'" x-small /></button>
								<v-icon name="palette" x-small /> Display
							</span>
						</div>
						<template v-if="displayPanelOpen">
							<div class="edit-grid">
								<label>Point size<input v-model.number="pointSize" type="number" step="0.2" min="0.4" max="6" /></label>
								<label v-if="liveOn">Show every<select v-model.number="plotStride"><option :value="1">all pts</option><option :value="2">2nd</option><option :value="5">5th</option><option :value="10">10th</option><option :value="25">25th</option></select></label>
							</div>
							<ColorScaleEditor v-model:color-scale="colorScale" v-model:locked="locked"
								:domain-lo="colorDomainLo" :domain-hi="colorDomainHi" :histogram="colorHistogram" :unit="`${axis} (N)`" />
							<template v-if="liveOn">
								<div class="stat-sep">Full-resolution render (host)</div>
								<div class="render-row">
									<label>Points<input v-model.number="renderPoints" type="number" step="50000" min="1000" /></label>
									<button class="processbtn" :disabled="rendering" @click="processFullRes">
										<v-icon :name="rendering ? 'hourglass_top' : 'memory'" x-small /> {{ rendering ? 'Rendering…' : 'Process' }}
									</button>
								</div>
								<div v-if="renderMsg" class="render-msg">{{ renderMsg }}</div>
							</template>
						</template>
					</div>

					<!-- Signal statistics: collapsed by default; computed client-side from the live
					     cache (crop-window force stats + whole-signal bit-depth / clipping analysis). -->
					<div v-if="detail" class="card info info-stats" :class="{ collapsed: !statsOpen }">
						<div class="info-head">
							<span>
								<button class="chevbtn" title="Collapse/expand" @click="togglePanel('stats')"><v-icon :name="statsOpen ? 'expand_more' : 'chevron_right'" x-small /></button>
								<v-icon name="query_stats" x-small /> Signal statistics
							</span>
							<span v-if="sigStats" class="stats-win mono">{{ sigStats.windowSec[0].toFixed(1) }}–{{ sigStats.windowSec[1].toFixed(1) }} s
								<button class="linkbtn" title="Download these statistics as CSV" @click="downloadStatsCsv">Download CSV</button>
								<button class="linkbtn" title="Copy these statistics to the clipboard as CSV" @click="copyStatsCsv">{{ statsCopied ? 'Copied' : statsCopyFailed ? 'Copy failed' : 'Copy' }}</button>
							</span>
						</div>
						<template v-if="statsOpen">
							<div v-if="!detail.live_cache_file" class="empty sm">No signal cache — reprocess this op to enable statistics</div>
							<div v-else-if="statsBusy" class="loading sm"><v-progress-circular indeterminate small /> computing…</div>
							<div v-else-if="statsErr" class="render-msg">{{ statsErr }}</div>
							<template v-else-if="sigStats">
								<table class="stats-table">
									<thead><tr><th></th><th>Fx</th><th>Fy</th><th>Fz</th></tr></thead>
									<tbody>
										<tr><td>Mean <span class="u">N</span></td><td v-for="a in STAT_AXES" :key="'m'+a">{{ fmtStat(sigStats.axes[a].mean) }}</td></tr>
										<tr><td>RMS <span class="u">N</span></td><td v-for="a in STAT_AXES" :key="'r'+a">{{ fmtStat(sigStats.axes[a].rms) }}</td></tr>
										<tr><td>Std <span class="u">N</span></td><td v-for="a in STAT_AXES" :key="'s'+a">{{ fmtStat(sigStats.axes[a].std) }}</td></tr>
										<tr><td>Min / Max <span class="u">N</span></td><td v-for="a in STAT_AXES" :key="'x'+a">{{ fmtStat(sigStats.axes[a].min) }} / {{ fmtStat(sigStats.axes[a].max) }}</td></tr>
										<tr><td>Dyn. range <span class="u">bits</span></td><td v-for="a in STAT_AXES" :key="'b'+a">{{ sigStats.axes[a].effBits?.toFixed(1) ?? '—' }}</td></tr>
										<tr><td>Rail hits <span class="u">lo/hi %</span></td><td v-for="a in STAT_AXES" :key="'c'+a">
											<span :class="{ 'stat-bad': sigStats.axes[a].clipped }">{{ sigStats.axes[a].railLoPct.toFixed(2) }} / {{ sigStats.axes[a].railHiPct.toFixed(2) }}<template v-if="sigStats.axes[a].clipped"> ⚠ clip</template></span>
										</td></tr>
									</tbody>
								</table>
								<p class="setting-note">Force stats over the crop window; bits + rails over the whole cached signal (CSV columns ending _whole). Dyn. range = log2(signal span ÷ noise floor); a clean full-range 12-bit capture sits near ~12–13, well below = under-ranged. Sustained rail hits = clipped / over-ranged.</p>
								<div class="kv stats-rpm"><span>RPM (window)</span><span>{{ fmtStat(sigStats.rpm.mean) }} ± {{ fmtStat(sigStats.rpm.std) }} <span class="u">({{ fmtStat(sigStats.rpm.min) }}–{{ fmtStat(sigStats.rpm.max) }})</span></span></div>
							</template>
							<button v-else class="processbtn stats-compute" :disabled="statsBusy" @click="computeStats">
								<v-icon name="calculate" x-small /> Compute<template v-if="statsCacheMb"> (downloads ~{{ statsCacheMb }} MB signal cache)</template>
							</button>
						</template>
					</div>

					<!-- Cutting metrics: resultant force, Fc/Ff/Fp, vc, Pc, kc over the crop window. Needs the
					     statistics (same window, same cache), so it shows a hint until those are computed. -->
					<div v-if="detail" class="card info info-cutting" :class="{ collapsed: !cuttingOpen }">
						<div class="info-head">
							<span>
								<button class="chevbtn" title="Collapse/expand" @click="togglePanel('cutting')"><v-icon :name="cuttingOpen ? 'expand_more' : 'chevron_right'" x-small /></button>
								<v-icon name="precision_manufacturing" x-small /> Cutting metrics
							</span>
						</div>
						<template v-if="cuttingOpen">
							<div v-if="!cutting" class="empty sm">Compute Signal statistics first (same crop window).</div>
							<template v-else>
								<table class="stats-table cutting-table">
									<thead><tr><th></th><th>Mean</th><th>Peak</th></tr></thead>
									<tbody>
										<tr><td>Resultant |F| <span class="u">N</span></td>
											<td :title="cutTip(cutting.resultant.mean, '|F| = √(Fx² + Fy² + Fz²) per sample, mean over the window')">{{ cutVal(cutting.resultant.mean) }}</td>
											<td :title="cutTip(cutting.resultant.peak, '|F| = √(Fx² + Fy² + Fz²) per sample, maximum over the window')">{{ cutVal(cutting.resultant.peak) }}</td></tr>
										<tr v-for="r in (['Fc', 'Ff', 'Fp'] as const)" :key="r">
											<td>{{ r }} <span class="u">N</span> <span class="u">({{ r === 'Fc' ? 'cutting' : r === 'Ff' ? 'feed' : 'passive' }}, {{ cutting.axisMap[r] }})</span></td>
											<td :title="cutTip(cutting[r].mean, `${r} = |mean ${cutting.axisMap[r]}| over the window. ${cuttingMapText}`)">{{ cutVal(cutting[r].mean) }}</td>
											<td :title="cutTip(cutting[r].peak, `${r} peak = max |${cutting.axisMap[r]}| over the window. ${cuttingMapText}`)">{{ cutVal(cutting[r].peak) }}</td></tr>
									</tbody>
								</table>
								<div class="kv" :title="cutTip(cutting.vcMPerMin, 'vc = π · D · n / 1000 [m/min], D in mm at the window midpoint (the disc shrinks by 2·f per rev), n = measured mean RPM in the window')"><span>Cutting speed vc</span><span>{{ cutVal(cutting.vcMPerMin) }} <span class="u">m/min</span></span></div>
								<div class="kv" :title="cutTip(cutting.pcW, 'Pc = Fc · vc / 60 [W] (vc in m/min), mean Fc. Feed-force power neglected.')"><span>Cutting power Pc</span><span>{{ cutVal(cutting.pcW) }} <span class="u">W</span></span></div>
								<div class="kv" :title="cutTip(cutting.kcMPa, 'kc = Fc / (ap · f) [N/mm² = MPa], mean Fc, ap = axial depth of cut, f = feed per rev')"><span>Specific cutting energy kc</span><span>{{ cutVal(cutting.kcMPa, 0) }} <span class="u">N/mm²</span></span></div>
								<p v-if="cutting.pcW.value == null || cutting.kcMPa.value == null" class="setting-note">
									<template v-if="cutting.Fc.mean.value == null">{{ cutting.Fc.mean.reason }}.</template>
									<template v-else>
										<template v-if="cutting.pcW.value == null">Pc: {{ cutting.pcW.reason }}. </template>
										<template v-if="cutting.kcMPa.value == null">kc: {{ cutting.kcMPa.reason }}.</template>
									</template>
								</p>
								<label class="setting-note cutting-map">Axis mapping<template v-if="axisMapSubtype"> for {{ axisMapSubtype }}</template>:
									<select v-model="axisMapSel" :title="cuttingMapText" @change="onAxisMapChange">
										<option v-for="a in AXIS_MAPS" :key="a.key" :value="a.key">{{ formatAxisMap(a.map) }}</option>
									</select>
								</label>
								<p class="setting-note">Depends on workholding and operation, so it is remembered per operation type. Standard: {{ AXIS_MAP_STANDARD }}.</p>
								<p class="setting-note">Over the crop window. Values use the operation's feed and depth of cut (else the capture's), the Diameter control and the measured mean RPM. Hover a value for its formula.</p>
							</template>
						</template>
					</div>

					<!-- Signal filters: interactive preview in Lite (raw|filtered compare), bake to
					     apply the chain to every output. Collapsed by default. -->
					<div v-if="detail" class="card info info-filters" :class="{ collapsed: !filtersOpen }">
						<div class="info-head">
							<span>
								<button class="chevbtn" title="Collapse/expand" @click="togglePanel('filters')"><v-icon :name="filtersOpen ? 'expand_more' : 'chevron_right'" x-small /></button>
								<v-icon name="filter_alt" x-small /> Signal filters
							</span>
							<span v-if="bakedChain" class="frm-fid good" title="This op's outputs are baked with a filter chain">baked</span>
							<span v-else-if="appliedLight" class="frm-fid" title="Saved as this op's default — Lite recomputes it live; Full & FRM PNG stay raw until you Bake">applied · Lite</span>
						</div>
						<template v-if="filtersOpen">
							<div v-if="!detail.live_cache_file" class="empty sm">No signal cache — reprocess this op to enable filtering</div>
							<template v-else>
								<div v-if="!liveOn" class="setting-note">Switch to <b>Lite</b> to preview filters side-by-side. You can still edit + bake here.</div>
								<div class="filt-row"><label class="chk"><input v-model="workChain.despike.on" type="checkbox" /> Despike</label>
									<template v-if="workChain.despike.on"><input v-model.number="workChain.despike.window" type="number" min="3" step="2" title="window (odd)" /><input v-model.number="workChain.despike.sigma" type="number" min="1" step="0.5" title="σ" /></template></div>
								<div class="filt-row"><label class="chk"><input v-model="workChain.detrend.on" type="checkbox" /> Detrend</label>
									<template v-if="workChain.detrend.on"><select v-model="workChain.detrend.mode"><option value="highpass">high-pass</option><option value="dc">DC</option></select><input v-if="workChain.detrend.mode==='highpass'" v-model.number="workChain.detrend.cutoff_hz" type="number" min="0.1" step="1" title="cutoff Hz" /></template></div>
								<div class="filt-row"><label class="chk"><input v-model="workChain.highpass.on" type="checkbox" /> High-pass</label>
									<template v-if="workChain.highpass.on"><input v-model.number="workChain.highpass.cutoff_hz" type="number" min="1" step="10" title="cutoff Hz" /><input v-model.number="workChain.highpass.order" type="number" min="1" max="10" title="order" /></template></div>
								<div class="filt-row"><label class="chk"><input v-model="workChain.lowpass.on" type="checkbox" /> Low-pass</label>
									<template v-if="workChain.lowpass.on"><input v-model.number="workChain.lowpass.cutoff_hz" type="number" min="1" step="100" title="cutoff Hz" /><input v-model.number="workChain.lowpass.order" type="number" min="1" max="10" title="order" /></template></div>
								<div class="filt-row"><label class="chk"><input v-model="workChain.notch.on" type="checkbox" /> Notch ×harmonics</label>
									<template v-if="workChain.notch.on"><input v-model.number="workChain.notch.q" type="number" min="1" step="5" title="Q" /></template></div>
								<div v-if="workChain.notch.on" class="filt-harm">
									<label v-for="h in [1,2,3,4,5]" :key="'h'+h" class="chk">
										<input type="checkbox" :checked="workChain.notch.harmonics.includes(h)"
											@change="workChain.notch.harmonics = ($event.target as HTMLInputElement).checked ? [...workChain.notch.harmonics, h].sort() : workChain.notch.harmonics.filter((x)=>x!==h)" /> {{ h }}×
									</label>
								</div>

								<div v-if="filterBusy" class="setting-note"><v-progress-circular indeterminate x-small /> previewing…</div>
								<div v-if="filterErr" class="render-msg">{{ filterErr }}</div>
								<div v-if="filterSkipped.length" class="setting-note">Preview-only note: {{ filterSkipped.join('; ') }} — bake applies at full rate.</div>

								<div class="filt-actions">
									<select class="prof-sel" @change="applyProfile(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value=''">
										<option value="">Load profile…</option>
										<option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
									</select>
									<button class="linkbtn" @click="saveProfile">Save…</button>
								</div>
								<div class="filt-actions">
									<button class="applybtn" :disabled="baking || !chainActive(workChain)" @click="applyFilter"
										title="Keep this filtered version as the op's default. Lite recomputes it live; Full & FRM PNG stay raw until you Bake."><v-icon name="done" x-small /> Apply (Lite)</button>
									<button class="processbtn" :disabled="baking || !chainActive(workChain)" @click="bakeFilters"
										title="Reprocess the op on the host so ALL outputs (Lite, Full, FRM PNG) are filtered. Heavier; needs the orchestrator; admin-only."><v-icon :name="baking ? 'hourglass_top' : 'save'" x-small /> {{ baking ? 'Baking…' : 'Bake all' }}</button>
									<button v-if="savedChain" class="recrawlbtn" :disabled="baking" @click="clearFilter">Clear</button>
								</div>
							</template>
						</template>
					</div>
				</div>

				<div v-if="!stacked && !detailHidden" class="resizer" @pointerdown="startColBResize" title="Drag to resize"></div>

				<!-- COL 3+4: signals + FRM — independently hideable, resizable against each other -->
				<div ref="rightAreaEl" class="right-area">
					<div v-if="!stacked && (colStackHidden || detailHidden)" class="fold-restore">
						<button v-if="colStackHidden" class="expandbtn" title="Show the samples/operations column" @click="colStackHidden = false">
							<v-icon name="chevron_right" x-small /> Lists
						</button>
						<button v-if="detailHidden" class="expandbtn" title="Show the sample/operation detail column" @click="detailHidden = false">
							<v-icon name="chevron_right" x-small /> Detail
						</button>
					</div>

					<GridLayout v-model:layout="rightLayout" class="right-grid" :col-num="stacked ? 1 : 12"
						:row-height="rightRowH" :margin="[10, 10]" :is-draggable="!stacked" :is-resizable="!stacked"
						:vertical-compact="true" :use-css-transforms="true">
						<GridItem v-for="item in rightLayout" :key="item.i" :x="item.x" :y="item.y" :w="item.w" :h="item.h" :i="item.i"
							:data-panel-id="item.i" drag-allow-from=".pg-grip" :min-w="3" :min-h="7">
						<div v-if="item.type === 'signals'" class="card col-charts pg-card">
							<div class="pg-bar">
								<span class="pg-grip" title="Drag to move"><v-icon name="drag_indicator" x-small /></span>
								<!-- The title is the plot mode and picks it, as in the Record page's panel headers. -->
								<span class="pg-title"><v-icon name="insights" x-small />
									<PlotModeFlyout v-model="chartMode" :modes="CHART_MODES" />
									<span v-if="liveOn" class="live-badge">LIVE</span>
									<template v-if="liveOn && (cropDirty || cropSavePrompt || cropSavedMsg)">
										<button v-if="!cropSavePrompt && !cropSavedMsg" class="crop-save" title="Persist this crop as the operation's official crop window" @click.stop="cropSavePrompt = true">Save crop</button>
										<span v-if="cropSavePrompt" class="crop-confirm" @click.stop>
											Save as official crop?
											<button class="cc-yes" :disabled="cropSaving" @click="saveCropAsOfficial">{{ cropSaving ? '…' : 'Save' }}</button>
											<button class="cc-no" :disabled="cropSaving" @click="cropSavePrompt = false">Cancel</button>
										</span>
										<span v-if="cropSavedMsg" class="crop-msg">{{ cropSavedMsg }}</span>
									</template>
									<span v-if="linkMsg" class="crop-msg">{{ linkMsg }}</span>
								</span>
								<div class="toggle pg-tools">
									<button class="tbtn icobtn" :class="{ on: rectZoomTool }" title="Rectangular zoom — drag a box on any graph"
										:style="rectZoomTool ? { background: 'var(--fp-accent)', borderColor: 'var(--fp-accent)', color: 'var(--fp-accent-ink)' } : {}"
										@click="rectZoomTool = !rectZoomTool"><v-icon name="crop_free" x-small /></button>
									<button class="tbtn icobtn" title="Reset zoom" :disabled="!zoomed" @click="resetZoom"><v-icon name="restart_alt" x-small /></button>
									<button v-for="a in AXES" :key="a" class="tbtn axchip" :class="{ on: (item.channels || AXES).includes(a) }"
										:style="(item.channels || AXES).includes(a) ? { color: AXIS_COLOR[a], borderColor: AXIS_COLOR[a] } : {}"
										:title="`Show ${a} in this panel`" @click="toggleItemAxis(item, a)">{{ a }}</button>
									<button v-if="effectiveMode === 'force'" class="tbtn rpmbtn" :class="{ on: item.rpm }"
										:style="item.rpm ? { background: '#a855f7', borderColor: '#a855f7' } : {}"
										@click="item.rpm = !item.rpm">RPM</button>
									<span v-if="effectiveMode === 'force' && radialFetchBusy" class="cmp-hint">loading radial…</span>
								</div>
								<button class="pg-x" title="Close panel" @click="closeRightPanel(item.i)"><v-icon name="close" x-small /></button>
							</div>
							<!-- Multi-cut comparison. Force mode only: overlaying spectra or spectrograms
								 from different cuts is not readable, and the wear question this answers is
								 a time-domain one. -->
							<div v-if="detail && effectiveMode === 'force'" class="cmp-bar">
								<span class="cmp-label"><v-icon name="stacked_line_chart" x-small /> Compare</span>
								<span v-for="c in compareItems" :key="c.id" class="cmp-chip" :style="{ borderColor: c.color, color: c.color }">
									{{ c.label }}
									<button class="cmp-ref" :class="{ on: compareRefId === c.id }" :aria-pressed="compareRefId === c.id"
										:title="compareRefId === c.id ? 'Reference for Difference (click to unset)' : 'Use as the reference for Difference'"
										@click="toggleCompareRef(c.id)">ref</button>
									<button class="cmp-x" title="Remove from comparison" @click="removeCompare(c.id)">×</button>
								</span>
								<span v-if="compareBusy" class="cmp-hint">loading…</span>
								<div class="cmp-add">
									<button class="tbtn" :disabled="!compareCandidates.length"
										:title="compareCandidates.length ? 'Overlay another cut' : 'No other operations in the current list'"
										@click.stop="comparePickerOpen = !comparePickerOpen">+ Add cut</button>
									<div v-if="comparePickerOpen" class="cmp-menu" @click.stop>
										<button v-for="o in compareCandidates.slice(0, 40)" :key="o.id" @click="addCompare(o)">
											<span class="mono sm">{{ o.operation_id?.pass_code || sampleOf(o)?.sample_code || o.id }}</span>
											<span class="sub">{{ fmtDate(o.operation_id?.operation_date) }}</span>
										</button>
									</div>
								</div>
								<button v-if="compareItems.length" class="tbtn" title="Clear all comparisons" @click="clearCompare">Clear</button>
								<button v-if="compareItems.length" class="tbtn" :class="{ on: diffOn }" :style="diffOn ? { background: 'var(--theme--primary, #6644ff)', borderColor: 'var(--theme--primary, #6644ff)' } : {}" :disabled="!compareRefId" :aria-pressed="diffOn"
									:title="compareRefId ? `Show ${axis} of this cut minus ${compareRefLabel}` : 'Mark a cut as ref first'"
									@click="diffOn = !diffOn">Difference</button>
							</div>
							<div v-if="diffOn && compareRefId && chartMode === 'force'" class="cmp-diff">
								<template v-if="diffResult && diffSpark">
									<svg :viewBox="`0 0 ${DIFF_W} ${DIFF_H}`" :width="DIFF_W" :height="DIFF_H" role="img"
										:aria-label="`${axis} difference versus ${compareRefLabel}`">
										<line x1="0" :x2="DIFF_W" :y1="diffSpark.zeroY" :y2="diffSpark.zeroY" class="cmp-diff-zero" />
										<path :d="diffSpark.d" fill="none" class="cmp-diff-line" />
									</svg>
									<span class="cmp-diff-read">
										<b>{{ axis }}</b> − {{ compareRefLabel }}, {{ diffSpark.t0.toFixed(1) }}–{{ diffSpark.t1.toFixed(1) }} s:
										mean {{ fmtDelta(diffResult.mean) }} N · RMS {{ diffResult.rms.toPrecision(3) }} N
									</span>
								</template>
								<span v-else class="cmp-hint">No overlap with the reference for {{ axis }} within both cuts' crops{{ zoomed ? ' and the zoom' : '' }}.</span>
							</div>
							<div v-if="!detail" class="empty">Select an operation to view its signals</div>
							<div v-else-if="isSpectral" class="charts-col">
								<SpectrumView v-for="a in axesFor(item)" :key="a" :cache-file-id="detail.live_cache_file"
									:chain="specChain" :axis="a" :mode="(chartMode as 'psd' | 'spectrogram' | 'waterfall')" :color="AXIS_COLOR[a]" />
							</div>
							<div v-else class="charts-col" :class="{ switching: loadingDetail }" :aria-busy="loadingDetail">
								<ForceChart v-for="c in chartsFor(item)" v-bind="c" :key="c.key" :hover-index="hoverIndex" @hover="hoverIndex = $event"
									:crop-editable="c.kind === 'env'" :active="c.key === axis"
									:overlay="(chartMode === 'fft' && filtersOpen && c.kind === 'line' && c.key === axis) ? filterFftOverlay : null"
									:view-start="zoomStart" :view-end="zoomEnd" :zoom-tool="rectZoomTool" @zoom="onChartZoom"
									@update:crop-start="onCropEdit('start', $event)" @update:crop-end="onCropEdit('end', $event)"
									:mark-x="c.kind === 'env' && chartMode === 'force' ? markTime : null" menu @chartmenu="openChartMenu" />
							</div>
						</div>

						<div v-else-if="item.type === 'wear'" class="card pg-card">
							<div class="pg-bar">
								<span class="pg-grip" title="Drag to move"><v-icon name="drag_indicator" x-small /></span>
								<span class="pg-title"><v-icon name="trending_up" x-small /> Wear trend</span>
								<button class="pg-x" title="Close panel" @click="closeRightPanel(item.i)"><v-icon name="close" x-small /></button>
							</div>
							<WearTrend :detail="detail" />
						</div>

						<!-- Metadata doctor. Two views over the same diagnose() output: the selected
						     operation's findings with their fixes, and a scan of the whole archive. -->
						<div v-else-if="item.type === 'doctor'" class="card pg-card doc-card">
							<div class="pg-bar">
								<span class="pg-grip" title="Drag to move"><v-icon name="drag_indicator" x-small /></span>
								<span class="pg-title"><v-icon name="health_and_safety" x-small /> Metadata doctor</span>
								<span class="segmode doc-mode">
									<button class="segbtn" :class="{ on: doctorScope === 'op' }" @click="doctorScope = 'op'">This op</button>
									<button class="segbtn" :class="{ on: doctorScope === 'all' }" @click="doctorScope = 'all'">All</button>
								</span>
								<button class="pg-x" title="Close panel" @click="closeRightPanel(item.i)"><v-icon name="close" x-small /></button>
							</div>

							<div class="doc-body">
								<div class="doc-opts">
									<span class="doc-optlabel">Also check</span>
									<label v-for="c in DOCTOR_OPTIONAL" :key="c.id" class="doc-opt">
										<input type="checkbox" :checked="doctorOptional.includes(c.id)" @change="toggleOptionalCheck(c.id)" />
										<span>{{ c.label }}</span>
									</label>
								</div>

								<!-- Selected operation -->
								<template v-if="doctorScope === 'op'">
									<div v-if="!detail" class="empty">Select an operation</div>
									<div v-else-if="!doctorActive.length && !doctorDismissedList.length" class="doc-ok">
										<v-icon name="check_circle" small /> No metadata issues found
									</div>
									<template v-else>
										<div v-for="f in doctorActive" :key="f.id" class="doc-find" :class="f.severity">
											<div class="doc-find-head">
												<span class="doc-sev" :class="f.severity"></span>
												<span class="doc-title">{{ f.title }}</span>
											</div>
											<p class="doc-detail">{{ f.detail }}</p>
											<div v-if="f.matValue != null || f.dbValue != null" class="doc-cmp">
												<span class="doc-side"><em>.mat</em> <b>{{ fmtOrDash(f.matValue) }}</b></span>
												<span class="doc-arrow">vs</span>
												<span class="doc-side"><em>D1</em> <b>{{ fmtOrDash(f.dbValue) }}</b></span>
											</div>
											<div class="doc-acts">
												<!-- Labelled so it is unambiguous which record changes: the .mat is never
												     written (see mat-metadata-migration — fileVersion selects the force
												     matrix parser, so editing legacy metadata corrupts parsing). -->
												<button v-if="canAdopt(f)" class="doc-btn primary" @click="applyFix(f)">
													Use .mat value in D1
												</button>
												<button v-else-if="f.fix === 'regen'" class="doc-btn primary" @click="applyFix(f)">Regenerate name</button>
												<button v-else-if="f.fix === 'crop'" class="doc-btn primary" @click="applyFix(f)">Adjust crop…</button>
												<button v-else-if="f.fix === 'link'" class="doc-btn primary" @click="applyFix(f)">Open record…</button>
												<button class="doc-btn" :disabled="doctorBusy === f.id" @click="setDismissed(f, true)">Not a problem</button>
											</div>
										</div>

										<div v-if="doctorDismissedList.length" class="doc-dismissed">
											<span class="doc-optlabel">Dismissed</span>
											<div v-for="f in doctorDismissedList" :key="f.id" class="doc-dis-row">
												<span class="doc-title">{{ f.title }}</span>
												<button class="doc-btn" :disabled="doctorBusy === f.id" @click="setDismissed(f, false)">Restore</button>
											</div>
										</div>
									</template>
									<div v-if="doctorErr" class="doc-err">{{ doctorErr }}</div>
								</template>

								<!-- Whole archive -->
								<template v-else>
									<div v-if="!doctorGroups.length" class="doc-ok">
										<v-icon name="check_circle" small /> No metadata issues across {{ rows.length }} operations
									</div>
									<div v-for="g in doctorGroups" :key="g.id" class="doc-group">
										<div class="doc-group-head">
											<span class="doc-sev" :class="g.severity"></span>
											<span class="doc-title">{{ g.title }}</span>
											<span class="chip">{{ g.rows.length }}</span>
										</div>
										<!-- data-row-id is the ANALYSIS-row id, which is not 1:1 with the pass_code
										     shown: one operation can have more than one .mat, so two rows can
										     carry the same name. Count on this, never on the label. -->
										<button v-for="r in g.rows" :key="r.id" class="doc-oprow" :data-row-id="r.id"
											:class="{ active: selectedRowId === r.id }" @click="selectOp(r)">
											<span class="mono sm">{{ r.operation_id?.pass_code || sampleOf(r)?.sample_code || r.id }}</span>
										</button>
									</div>
								</template>
							</div>
						</div>

						<div v-else-if="item.type === 'frm'" class="card col-frm frm-col pg-card">
							<div class="frm-head pg-headbar">
								<span class="pg-grip" title="Drag to move"><v-icon name="drag_indicator" x-small /></span>
								<span class="frm-kicker"><v-icon name="fingerprint" x-small /> {{ octreeOn ? (gridActive ? 'Full FRM · gridded' : 'Full FRM') : (liveOn ? 'Lite FRM' : 'FRM figure') }}</span>
								<span v-if="(octreeOn || liveOn) && fullResPoints" class="frm-res"
									:title="`Displayed ${displayedPoints.toLocaleString()} of ${fullResPoints.toLocaleString()} full-resolution points`">
									<v-icon name="grain" x-small /> {{ fmtPts(displayedPoints) }} / {{ fmtPts(fullResPoints) }}<template v-if="resolutionPct != null"> · {{ resolutionPct }}%</template>
								</span>
								<span v-if="gridActive && gridFidelityPct != null" class="frm-fid" :class="{ good: gridFidelityPct >= 95 }"
									:title="`Interpolated-grid fidelity (hold-out-arms CV). Arm/cell ratio ${detail.grid_arm_ratio?.toFixed?.(1) ?? '—'}`">
									grid · fidelity ~{{ gridFidelityPct }}%
								</span>
								<span v-else-if="gridActive" class="frm-fid" title="Fidelity could not be computed (too few arms)">grid · fidelity n/a</span>
								<span v-if="bakedChain" class="frm-fid good" :title="`Baked filters: ${chainSummary(bakedChain)}`">⚙ filtered</span>
								<span v-else-if="compareOn" class="frm-fid" :title="chainSummary(workChain)">compare · preview</span>
								<span v-else-if="filteredSoloOn" class="frm-fid" :title="`Lite live-filtered: ${chainSummary(savedChain)} — Full & FRM PNG still raw until baked`">filtered · Lite</span>
								<div class="toggle">
									<div class="segmode">
										<button class="segbtn" :class="{ on: frmMode==='figure', busy: frmBusy && frmMode==='figure' }" :aria-busy="frmBusy && frmMode==='figure'" @click="chooseMode('figure')" title="Prerendered figure (instant)">Figure</button>
										<button class="segbtn" :class="{ on: frmMode==='lite', busy: frmBusy && frmMode==='lite' }" :aria-busy="frmBusy && frmMode==='lite'" :disabled="!liveAvailable" @click="liveAvailable && chooseMode('lite')" :title="liveAvailable ? 'Lite interactive cloud (reacts to crop/feed)' : 'No live cache — reprocess to enable'">Lite</button>
										<button class="segbtn" :class="{ on: frmMode==='full', busy: frmBusy && frmMode==='full' }" :aria-busy="frmBusy && frmMode==='full'" :disabled="buildingOctree" @click="octreeAvailable ? chooseMode('full') : buildOctree()" :title="octreeAvailable ? 'Full-resolution octree (LOD-streamed)' : 'Build the full-resolution octree on the host'"><v-icon v-if="buildingOctree" name="hourglass_top" x-small /> Full</button>
									</div>
									<button v-if="frmMode==='full'" class="tbtn" :class="{ on: gridFull }" :disabled="buildingOctree"
										:title="gridAvailable ? 'Interpolated-grid octree (filled surface)' : 'Build the interpolated grid on the host'"
										:style="gridFull ? { background: 'var(--fp-accent)', borderColor: 'var(--fp-accent)', color: 'var(--fp-accent-ink)' } : {}"
										@click="gridFull = !gridFull"><v-icon name="grid_on" x-small /> Gridded</button>
									<select v-if="octreeOn || liveOn" v-model="zSeries" class="zsel" title="Drive the Z axis from a force series (3D view — drag to rotate)">
										<option value="none">2D</option>
										<option value="Fx">Z = Fx</option>
										<option value="Fy">Z = Fy</option>
										<option value="Fz">Z = Fz</option>
									</select>
									<input v-if="(octreeOn || liveOn) && zSeries !== 'none'" type="range" class="zslider"
										min="0" max="2" step="0.05" v-model.number="zScale"
										title="Z exaggeration (or a 3-finger vertical swipe on the plot)" />
									<button v-if="detail && (liveOn || octreeOn || detail[`frm_${axis.toLowerCase()}`])" class="tbtn"
										:title="(liveOn || octreeOn) ? 'Download the current view (this zoom) as a PNG' : 'Download this FRM image'"
										@click="downloadFrm"><v-icon name="download" x-small /></button>
									<button v-for="a in AXES" :key="a" class="tbtn" :class="{ on: axis === a }"
										:style="axis === a ? { background: AXIS_COLOR[a], borderColor: AXIS_COLOR[a] } : {}"
										@click="setAxis(a)">{{ a }}</button>
								</div>
								<button class="pg-x" title="Close panel" @click="closeRightPanel(item.i)"><v-icon name="close" x-small /></button>
							</div>
							<div class="frm-img" :class="{ switching: loadingDetail }" :aria-busy="loadingDetail">
								<div v-if="!detail" class="empty">Select an operation</div>
								<FrmOctree v-else-if="octreeOn" ref="frmOctreeRef"
									:octree-path="gridActive ? detail.grid_octree_path : detail.octree_path" :axis="axis"
									:color-scale="colorScale" :point-size="pointSize"
									:z-series="zSeries" :z-scale="zScale"
									:total-points="gridActive ? Number(detail.grid_octree_points) : (fullResPoints ?? undefined)"
									:fill="gridActive" :cell-size="Number(detail.grid_cell_mm) || 1"
									:min-node-px="octreeMinNodePx" :budget-cap="octreeBudgetCap"
									:sample-cache="octreeSampleCache" :inner-diam="Number(detail.inner_diameter) || 0" :ppr="Number(detail.pulses_per_rev) || 1"
									:mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
									@climits="onClimits" @points="displayedPoints = $event" @zscale="zScale = $event" @stage="frmStage = $event" />
								<!-- Compare mode: raw | filtered, sharing one view (linked pan/zoom) + colour scale. -->
								<div v-else-if="compareOn" class="frm-compare" :class="{ stacked }">
									<FrmCloud ref="frmCloudRef" v-bind="cloudProps" :cache-override="rawDecimatedCache" :color-scale="colorScale"
										:shared-view="compareView" pane-label="raw" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
										@loaded="onCloudLoaded" @climits="onClimits" @histogram="rendererHistogram = $event" @points="displayedPoints = $event" @stage="frmStage = $event" />
									<FrmCloud v-bind="cloudProps" :cache-override="filteredCache" :color-scale="filteredColorScale"
										:shared-view="compareView" pane-label="filtered" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
										@climits="filteredAuto = $event" />
								</div>
								<FrmCloud v-else-if="filteredSoloOn" ref="frmCloudRef" v-bind="cloudProps" :cache-override="filteredCache" :color-scale="colorScale" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
										:z-series="zSeries" :z-scale="zScale"
										@loaded="onCloudLoaded" @climits="onClimits" @histogram="rendererHistogram = $event" @points="displayedPoints = $event"
										@zscale="zScale = $event" />
									<FrmCloud v-else-if="liveOn" ref="frmCloudRef" v-bind="cloudProps" :color-scale="colorScale" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
									:z-series="zSeries" :z-scale="zScale"
									@loaded="onCloudLoaded" @climits="onClimits" @histogram="rendererHistogram = $event" @points="displayedPoints = $event"
									@zscale="zScale = $event" @stage="frmStage = $event" />
								<div v-else-if="frmLoading" class="fig-loading"><LoadingOverlay :stage="figStage" /></div>
								<img v-else-if="frmUrl" :src="frmUrl" :alt="`FRM ${axis}`" />
								<div v-else class="empty">No {{ axis }} fingerprint</div>
								<div v-if="octreeMsg && !liveOn" class="render-msg frm-render-msg">{{ octreeMsg }}</div>
							</div>
						</div>
						</GridItem>
					</GridLayout>
				</div>
			</div>

			<!-- Combined metadata + crop "Save changes" summary — one dialog, one write sequence
			     (metadata to manufacturing_operations, then crop to machining_force_analysis via
			     saveCropAsOfficial, see saveChanges()). Self-contained (no ConfirmDialog import — this
			     package has no path into apps/force-app/web/src/ui/, which is where that component
			     lives), mirroring its <dl> diff-list structure rather than importing it. -->
			<div v-if="changesDialogOpen" class="changes-backdrop" @click.self="changesDialogOpen = false">
				<div class="changes-dialog">
					<h3>Save changes</h3>
					<p v-if="!changeSummary.length" class="empty sm">Nothing to save.</p>
					<dl v-else class="changes-list">
						<template v-for="row in changeSummary" :key="row.label">
							<dt>{{ row.label }}</dt>
							<dd>{{ row.from }} → {{ row.to }}</dd>
						</template>
					</dl>
					<div v-if="metaSaveErr" class="render-msg">{{ metaSaveErr }}</div>
					<div class="changes-actions">
						<button class="cd-no" :disabled="metaSaving" @click="changesDialogOpen = false">Cancel</button>
						<button class="cd-yes" :disabled="metaSaving || !changeSummary.length" @click="saveChanges">{{ metaSaving ? 'Saving…' : 'Save' }}</button>
					</div>
				</div>
			</div>
			<PlotHelp v-if="helpOpen" @close="helpOpen = false" />
			<!-- Map / chart right-click menu (position:fixed, so it can sit at the dashboard root). -->
			<ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menu.items" @close="menu = null" />
		</div>
	</private-view>
</template>

<style scoped>
.fd {
	/* App tokens, falling back to the Directus theme when this renders inside the admin. */
	--fp-accent: var(--accent, var(--theme--primary, #1d4ed8));
	--fp-accent-ink: var(--accent-ink, var(--theme--foreground-inverted, #fff));
	padding: 20px 24px 40px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground, #1e293b);
	container-type: inline-size;   /* size children to the real content width, not the viewport */
}
/* Thin horizontal banner: title + counts on the left, panel toggles on the right. */
.hero { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 6px 14px; border-radius: 12px;
	color: #fff; background: linear-gradient(120deg, var(--theme--primary, #1d4ed8), #0d9488);
	box-shadow: 0 8px 20px -12px rgba(29, 78, 216, 0.5); flex-wrap: wrap; }
.hero-badge { display: inline-flex; align-items: center; gap: 7px; font-weight: 750; font-size: var(--fs-lg, 15px); }
.hero-badge :deep(.v-icon) { --v-icon-color: #fff; }
.hero-stat { font-size: var(--fs-sm, 12px); font-weight: 600; opacity: 0.9; }
.hero-spacer { flex: 1 1 auto; }
.hero .pt-label { color: rgba(255, 255, 255, 0.8); }
.hero .pt-chip { color: #fff; background: rgba(255, 255, 255, 0.16); border-color: rgba(255, 255, 255, 0.28); }
.hero .pt-chip:disabled { opacity: 0.5; }

.loading { display: grid; place-items: center; padding: 40px; }
.loading.sm { padding: 18px; }

.layout {
	display: grid;
	gap: 0; align-items: stretch;
	overflow: hidden;   /* the measured height is exact; panels scroll internally, the page doesn't */
}
.layout.stacked { align-items: start; overflow: visible; }
.layout.dragging { cursor: col-resize; }
.layout.dragging * { user-select: none; }

.col-stack, .col-charts, .col-frm, .right-area { min-width: 0; min-height: 0; }
.col-stack { display: flex; flex-direction: column; gap: 14px; padding-right: 6px; }
.panel-samples { flex: 0 0 auto; }
.panel-ops { flex: 1 1 auto; min-height: 0; }
.panel-ops .list { max-height: none; flex: 1 1 auto; }
/* Detail column = header-sized cards by default; the ONE open accordion (op detail / stats
   / filters, mutually exclusive) takes the remaining height and scrolls. A collapsed card
   must shrink to just its header — otherwise it kept flex:1 and left a big empty box. */
.col-stack .info { flex: 0 0 auto; min-height: 0; }
.col-stack .info-op, .col-stack .info-display, .col-stack .info-stats, .col-stack .info-filters { overflow-y: auto; }
.col-stack .info-op:not(.collapsed),
.col-stack .info-display:not(.collapsed),
.col-stack .info-stats:not(.collapsed),
.col-stack .info-filters:not(.collapsed) { flex: 1 1 auto; }
.col-stack .info.collapsed { flex: 0 0 auto; overflow: visible; }
.layout.stacked .col-stack .info:last-child { overflow: visible; }
.layout.stacked .panel-ops .list { max-height: 40vh; flex: none; }
.layout.stacked .col-charts .chart { flex: none; min-height: 180px; }
.col-charts { display: flex; flex-direction: column; }
.col-charts .charts-col { flex: 1 1 auto; min-height: 0; }
.col-charts .chart { flex: 1 1 0; }

/* Drag handles between columns (grid tracks on desktop, flex items in the
   Signals/FRM row) — thin, with a grab affordance on hover/drag. */
.resizer { width: 6px; cursor: col-resize; position: relative; flex: 0 0 6px; }
.resizer::after {
	content: ''; position: absolute; left: 2px; top: 10%; bottom: 10%; width: 2px;
	border-radius: 2px; background: var(--theme--border-color, #dbe2ea); transition: background 0.15s ease;
}
.resizer:hover::after, .layout.dragging .resizer::after { background: var(--theme--primary, #1d4ed8); }

.panel {
	background: var(--theme--background-subdued, #f7f9fb);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-radius: 16px; display: flex; flex-direction: column; overflow: hidden;
}
.panel-samples .list { max-height: 30vh; }
.panel-ops .list { max-height: 38vh; }
.dense .panel-ops .list { max-height: none; }
.panel-head {
	display: flex; align-items: center; gap: 8px; padding: 12px 14px;
	font-size: var(--fs-sm, 12px); font-weight: 600; letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #6b7684);
	border-bottom: 1px solid var(--theme--border-color-subdued, #e7ebf0);
}
.chip {
	font-size: var(--fs-xs, 11px); font-weight: 700; color: var(--theme--primary, #1d4ed8);
	background: color-mix(in srgb, var(--theme--primary, #1d4ed8) 12%, transparent);
	padding: 1px 7px; border-radius: 99px;
}
.clearbtn { margin-left: auto; border: 0; background: none; cursor: pointer; font: inherit; font-size: var(--fs-xs, 11px); font-weight: 700; text-transform: none; letter-spacing: 0; color: var(--theme--primary, #1d4ed8); }
.search {
	margin: 11px 12px 5px; padding: 8px 11px; font: inherit; font-size: var(--fs-md, 13px);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0); border-radius: 9px;
	background: var(--theme--background, #fff); color: inherit; outline: none;
}
.search:focus { border-color: var(--theme--primary, #1d4ed8); }
.list { overflow-y: auto; padding: 7px 11px 12px; display: flex; flex-direction: column; gap: 9px; }
/* Data-quality stoplight dot in the row's top-right corner (green ready · blue processing ·
   yellow octree-only · red none). */
.qdot { position: absolute; top: 8px; right: 9px; width: 6px; height: 6px; border-radius: 99px; }
.qdot.green { background: #16a34a; }
.qdot.yellow { background: #f59e0b; }
.qdot.blue { background: #3b82f6; }
.qdot.red { background: #ef4444; }
/* Marks the single most-recently-saved recording across all operations (see latestRowId) — an
   inline badge rather than another corner dot since .qdot's corner is already the quality light. */
.latest-chip {
	display: inline-flex; align-items: center; gap: 1px; margin-left: 5px;
	font-family: var(--theme--fonts--sans--font-family, system-ui, sans-serif);
	font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em;
	padding: 1px 6px 1px 4px; border-radius: 99px; color: #b45309;
	background: color-mix(in srgb, #f59e0b 18%, transparent);
	vertical-align: middle;
}
.latest-chip .v-icon-shim { font-size: var(--icon-xs, 14px) !important; }

/* ---- Metadata doctor -------------------------------------------------------------------
   .docdot is an inline count badge, NOT a second corner dot: .qdot already owns the corner and
   answers a different question (is this plottable), so the two must stay visually distinct. */
.docdot {
	display: inline-flex; align-items: center; justify-content: center; margin-left: 5px;
	min-width: 14px; height: 14px; padding: 0 4px; border-radius: 99px;
	font-family: var(--theme--fonts--sans--font-family, system-ui, sans-serif);
	font-size: var(--fs-xs, 11px); font-weight: 700; vertical-align: middle; color: #fff;
}
.docdot.error { background: #dc2626; }
.docdot.warn { background: #d97706; }
.docdot.info { background: #64748b; }
.doc-filter {
	display: flex; align-items: center; gap: 6px; padding: 4px 10px 6px;
	font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #6b7684); cursor: pointer;
}
.doc-filter input { margin: 0; cursor: pointer; }
.doc-card { display: flex; flex-direction: column; min-height: 0; }
.doc-mode { margin-left: auto; }
.doc-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 10px 10px; }
.doc-opts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.doc-optlabel {
	font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #6b7684);
}
.doc-opt { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs, 11px); cursor: pointer; }
.doc-opt input { margin: 0; cursor: pointer; }
.doc-ok { display: flex; align-items: center; gap: 6px; padding: 14px 2px; font-size: var(--fs-sm, 12px); color: #16a34a; }
.doc-find {
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-left-width: 3px; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px;
}
.doc-find.error { border-left-color: #dc2626; }
.doc-find.warn { border-left-color: #d97706; }
.doc-find.info { border-left-color: #64748b; }
.doc-find-head { display: flex; align-items: center; gap: 6px; }
.doc-sev { width: 7px; height: 7px; border-radius: 99px; flex: none; }
.doc-sev.error { background: #dc2626; }
.doc-sev.warn { background: #d97706; }
.doc-sev.info { background: #64748b; }
.doc-title { font-size: var(--fs-sm, 12px); font-weight: 600; }
.doc-detail { margin: 4px 0 0; font-size: var(--fs-xs, 11px); line-height: 1.45; color: var(--theme--foreground-subdued, #6b7684); }
.doc-cmp { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: var(--fs-xs, 11px); }
.doc-side em { font-style: normal; font-size: var(--fs-xs, 11px); letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #6b7684); margin-right: 4px; }
.doc-side b { font-family: var(--theme--fonts--monospace--font-family, ui-monospace, monospace); }
.doc-arrow { color: var(--theme--foreground-subdued, #6b7684); }
.doc-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.doc-btn {
	border: 1px solid var(--theme--border-color, #d3dae4); background: transparent;
	border-radius: 5px; padding: 3px 9px; font-size: var(--fs-xs, 11px); cursor: pointer;
	color: var(--theme--foreground, #263238);
}
.doc-btn:hover:not(:disabled) { background: var(--theme--background-subdued, #f4f6f8); }
.doc-btn:disabled { opacity: 0.5; cursor: default; }
.doc-btn.primary { border-color: var(--theme--primary, #6644ff); color: var(--theme--primary, #6644ff); font-weight: 600; }
.doc-dismissed { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--theme--border-color-subdued, #e7ebf0); }
.doc-dis-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; opacity: 0.65; }
.doc-err { margin-top: 8px; font-size: var(--fs-xs, 11px); color: #dc2626; }
.doc-group { margin-bottom: 10px; }
.doc-group-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.doc-oprow {
	display: block; width: 100%; text-align: left; border: 0; background: transparent;
	padding: 3px 8px; border-radius: 4px; cursor: pointer;
}
.doc-oprow:hover { background: var(--theme--background-subdued, #f4f6f8); }
.doc-oprow.active { background: color-mix(in srgb, var(--theme--primary, #6644ff) 12%, transparent); }
/* Multi-cut comparison bar (Signals panel, force mode). */
.cmp-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 10px;
	border-bottom: 1px solid var(--theme--border-color-subdued, #e7ebf0); }
.cmp-label { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs, 11px); font-weight: 700;
	letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #6b7684); }
.cmp-chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs, 11px); font-weight: 700;
	padding: 1px 4px 1px 8px; border: 1px solid; border-radius: 99px; }
.cmp-x { border: 0; background: none; cursor: pointer; color: inherit; font-size: var(--fs-md, 13px); line-height: 1; padding: 0 3px; }
.cmp-hint { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #98a2b3); }
.cmp-ref { border: 1px solid currentColor; background: none; cursor: pointer; color: inherit; font-size: 9px; font-weight: 700;
	line-height: 1.4; padding: 0 4px; border-radius: 4px; opacity: 0.6; text-transform: uppercase; }
.cmp-ref.on { opacity: 1; box-shadow: inset 0 0 0 1px currentColor; }
.cmp-diff { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 2px 4px 6px; font-size: var(--fs-xs, 11px); }
.cmp-diff svg { flex: none; max-width: 100%; border: 1px solid var(--theme--border-color-subdued, #e4eaf1); border-radius: 4px; background: var(--plot-bg, transparent); }
.cmp-diff-zero { stroke: var(--theme--foreground-subdued, #98a2b3); stroke-width: 1; stroke-dasharray: 3 3; }
.cmp-diff-line { stroke: var(--theme--primary, #6644ff); stroke-width: 1.2; }
.cmp-diff-read { font-variant-numeric: tabular-nums; }
.cmp-add { position: relative; }
.cmp-menu { position: absolute; top: 24px; left: 0; z-index: 40; min-width: 200px; max-height: 280px;
	overflow: auto; padding: 4px; background: var(--theme--background, #fff);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0); border-radius: 9px;
	box-shadow: 0 14px 40px rgba(15,23,42,0.18); }
.cmp-menu button { display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 6px 8px;
	background: transparent; border: 0; border-radius: 6px; cursor: pointer; text-align: left; color: inherit; }
.cmp-menu button:hover { background: var(--theme--background-subdued, #f4f6f8); }
.rowcard {
	position: relative;
	text-align: left; font: inherit; cursor: pointer; color: inherit;
	background: var(--theme--background, #fff); border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-radius: 12px; padding: 11px 13px; display: flex; flex-direction: column; gap: 4px;
	transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
}
.rowcard:hover { transform: translateY(-2px); box-shadow: 0 10px 22px -16px rgba(15, 23, 42, 0.4); }
.rowcard.active { border-color: var(--theme--primary, #1d4ed8); box-shadow: 0 0 0 1px var(--theme--primary, #1d4ed8) inset; }
.mono { font-family: var(--theme--fonts--monospace--font-family, 'SF Mono', Menlo, monospace); font-weight: 700; font-size: var(--fs-md, 13px); overflow-wrap: break-word; word-break: normal; }
.mono.sm { font-size: var(--fs-sm, 12px); }
.sub { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #6b7684); }
.pill, .badge { align-self: flex-start; margin-top: 2px; font-size: var(--fs-xs, 11px); font-weight: 700; padding: 1px 8px; border-radius: 99px; }
.pill { color: var(--theme--primary, #1d4ed8); background: color-mix(in srgb, var(--theme--primary, #1d4ed8) 12%, transparent); }
.badge { color: #fff; }
.empty { padding: 20px 16px; text-align: center; color: var(--theme--foreground-subdued, #98a2b3); font-size: var(--fs-md, 13px); }
.empty.sm { padding: 14px; font-size: var(--fs-sm, 12px); }

/* Radius and elevation taken from the Record page's PanelFrame so a card here and a panel there
   are the same object: 12px, one hairline border, one shallow shadow. */
.card {
	background: var(--theme--background, #fff); border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-radius: 12px; padding: 16px 18px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
}
.dense .card { padding: 12px 14px; }
.info-head {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #6b7684); margin-bottom: 11px;
}
.dense .info-head { margin-bottom: 8px; }
.openbtn {
	display: inline-flex; align-items: center; gap: 3px; border: 0; cursor: pointer; font: inherit;
	font-size: var(--fs-xs, 11px); font-weight: 700; text-transform: none; letter-spacing: 0;
	color: var(--theme--primary, #1d4ed8); background: color-mix(in srgb, var(--theme--primary, #1d4ed8) 10%, transparent);
	padding: 3px 8px; border-radius: 8px;
}
.openbtn:hover { background: color-mix(in srgb, var(--theme--primary, #1d4ed8) 18%, transparent); }
.info-code { font-size: var(--fs-md, 13px); margin-bottom: 12px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 7px 12px; font-size: var(--fs-md, 13px); margin-bottom: 4px; }
.dense .kv { gap: 4px 10px; font-size: var(--fs-sm, 12px); margin-bottom: 2px; }
.kv span:nth-child(odd) { color: var(--theme--foreground-subdued, #6b7684); white-space: nowrap; }
.kv span:nth-child(even) { font-weight: 600; text-align: right; }
.stat-sep {
	margin: 12px 0 9px; font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #98a2b3); border-top: 1px solid var(--theme--border-color-subdued, #eef1f5); padding-top: 10px;
}
.statgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.stat {
	background: var(--theme--background-subdued, #f7f9fb); border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-radius: 8px; padding: 5px 9px; display: flex; flex-direction: column; gap: 0;
}
.s-top { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
.s-val { font-size: var(--fs-md, 13px); font-weight: 750; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; line-height: 1.15; }
.s-unit { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--theme--foreground-subdued, #94a3b8); letter-spacing: 0.02em; }
.s-lab { font-size: var(--fs-xs, 11px); letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #6b7684); font-weight: 600; margin-top: 1px; }
/* editable cut-param boxes: an input styled like the value, with a dashed underline so it
   reads as editable WITHOUT clicking; the unit sits inline to its right (like the read-only
   boxes) to save vertical space. Modified = accent ring. */
.stat.edit { background: var(--theme--background, #fff); transition: border-color 0.12s, box-shadow 0.12s; }
.stat .s-inp {
	width: 4.4em; max-width: 100%; font: inherit; font-size: var(--fs-md, 13px); font-weight: 750; font-variant-numeric: tabular-nums;
	background: transparent; color: inherit; padding: 0 0 1px; line-height: 1.15;
	border: 0; border-bottom: 1px dashed var(--theme--border-color, #c7d0da); border-radius: 0;
}
.stat .s-inp::-webkit-outer-spin-button, .stat .s-inp::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.stat .s-inp { -moz-appearance: textfield; appearance: textfield; }
.stat .s-inp:hover { border-bottom-color: var(--theme--foreground-subdued, #94a3b8); }
.stat .s-inp:focus { outline: none; border-bottom: 1px solid var(--theme--primary, #1d4ed8); }
.stat.modified { border-color: var(--theme--primary, #1d4ed8); box-shadow: inset 0 0 0 1px var(--theme--primary, #1d4ed8); }
.stat.modified .s-lab { color: var(--theme--primary, #1d4ed8); }

/* Right area: Signals + FRM, independently hideable/resizable against each other. The grid can grow
   taller than the viewport (adding/moving panels), so this is the scroll container — min-height:0 lets
   it shrink inside the fixed-height layout cell and overflow-y makes off-screen panels reachable. */
.right-area { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.panel-toggles { display: flex; align-items: center; gap: 8px; padding: 0 2px; flex-wrap: wrap; }
.pt-label { font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #98a2b3); margin-right: 2px; }
.pt-chip {
	display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 650;
	cursor: pointer; padding: 5px 12px; border-radius: 99px; color: var(--theme--foreground-subdued, #6b7684);
	background: var(--theme--background-subdued, #f1f5f9); border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	transition: all 0.12s ease;
}
.pt-chip:disabled { opacity: 0.55; cursor: not-allowed; }

/* Flexible plot-panel grid (Signals / FRM as draggable, resizable, closeable panels). Pull the grid
   up by its top margin so row-0 panels align with the top of the samples/detail columns (the empty
   margin strip above row 0 is what gets clipped, not content). */
.right-grid { width: 100%; margin-top: -10px; }
.right-grid :deep(.vgl-item__resizer) { z-index: 3; }
.right-grid :deep(.vgl-item--placeholder) { background: color-mix(in srgb, var(--theme--primary, #1d4ed8) 18%, transparent); border-radius: 12px; }
.pg-card { height: 100%; display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
/* One-line panel bar: drag grip · title · inline tools · close — no separate title row. */
/* nowrap: the tools group wraps inside itself instead (.toggle already wraps, right-aligned). With
   the bar itself wrapping, a narrow Signals panel pushed the close button onto a line of its own.
   Grip, title and close are one tool-row tall and top-aligned, so they stay level with the first
   row of tools when the rest wrap below. */
.pg-bar { display: flex; align-items: flex-start; gap: 6px; padding: 2px 4px 6px; flex: 0 0 auto; }
.pg-bar > .pg-grip, .pg-bar > .pg-title, .pg-bar > .pg-x { min-height: 27px; align-items: center; }
/* Grows into the bar's free width: the Signals mode picker slides open into it. */
.pg-title { display: inline-flex; flex: 1 0 auto; align-items: center; gap: 5px; font-size: var(--fs-xs, 11px); font-weight: 700;
	letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #6b7684); white-space: nowrap; }
.pg-tools { flex: 0 1 auto; min-width: 0; }
.pg-grip { cursor: move; display: inline-flex; color: var(--theme--foreground-subdued, #98a2b3); }
.pg-grip:hover { color: var(--theme--foreground, #1e293b); }
.pg-x { margin-left: 4px; display: inline-flex; background: transparent; border: none; cursor: pointer; color: var(--theme--foreground-subdued, #98a2b3); border-radius: 5px; padding: 2px; }
.pg-x:hover { color: #dc2626; background: color-mix(in srgb, #dc2626 12%, transparent); }
/* FRM reuses its head row as the bar (grip prepended, close appended). */
.pg-headbar { padding-bottom: 6px; }
.pt-add { position: relative; }
.pt-menu { position: absolute; top: 32px; right: 0; z-index: 40; min-width: 150px; padding: 4px; border-radius: 9px; background: var(--theme--background, #fff); border: 1px solid var(--theme--border-color-subdued, #e7ebf0); box-shadow: 0 14px 34px rgba(0,0,0,0.2); }
.pt-menu button { display: flex; align-items: center; gap: 7px; width: 100%; padding: 7px 8px; font: inherit; font-size: var(--fs-sm, 12px); color: var(--theme--foreground, #1e293b); background: transparent; border: none; border-radius: 6px; cursor: pointer; text-align: left; }
.pt-menu button:hover { background: var(--theme--background-subdued, #f1f5f9); }

.graphs-title, .frm-kicker {
	display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs, 11px); font-weight: 700;
	letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #6b7684);
}
.toggle { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.tbtn {
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 700; cursor: pointer; padding: 5px 13px; border-radius: 9px;
	color: var(--theme--foreground-subdued, #6b7684); background: var(--theme--background-subdued, #f1f5f9);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0); transition: all 0.12s ease;
}
.tbtn.on { color: #fff; }
.tbtn.icobtn { padding: 5px 9px; display: inline-flex; align-items: center; }
/* Signals plots scroll INSIDE the panel (min-height:0 + overflow) instead of overflowing the card
   and pushing past the page bottom when a panel is short or several charts stack. */
.charts-col.switching, .frm-img.switching, .col-stack.switching { opacity: 0.45; pointer-events: none; transition: opacity 0.12s; }
.charts-col { display: flex; flex-direction: column; gap: 13px; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }

.col-frm { display: flex; flex-direction: column; gap: 11px; min-height: 0; }
.frm-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
.frm-res { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs, 11px); font-weight: 600; font-variant-numeric: tabular-nums;
	color: var(--theme--foreground-subdued, #6b7684); background: var(--theme--background-subdued, #f1f5f9);
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0); border-radius: 99px; padding: 1px 8px; margin-right: auto; }
.frm-fid { font-size: var(--fs-xs, 11px); padding: 1px 7px; border-radius: 99px; font-weight: 700;
	color: #b45309; background: color-mix(in srgb, #d97706 14%, transparent); white-space: nowrap; }
.frm-fid.good { color: #15803d; background: color-mix(in srgb, #16a34a 14%, transparent); }
.segmode { display: inline-flex; border-radius: 8px; overflow: hidden; border: 1px solid var(--theme--border-color-subdued, #d7dee6); }
.segbtn { font: inherit; font-size: var(--fs-xs, 11px); font-weight: 700; cursor: pointer; border: 0; padding: 5px 11px; background: var(--theme--background, #fff); color: var(--theme--foreground-subdued, #64748b); border-right: 1px solid var(--theme--border-color-subdued, #e7ebf0); }
.segbtn:last-child { border-right: 0; }
.segbtn.on { background: var(--fp-accent); color: var(--fp-accent-ink); }
.segbtn:disabled { opacity: 0.4; cursor: default; }
/* The active view type is still loading (#102): a bar sweeping along the button's foot. Under
   reduced motion the global rule stops the sweep and the bar stays as a static underline. */
.segbtn.busy { position: relative; }
.segbtn.busy::after { content: ''; position: absolute; left: 6px; right: 6px; bottom: 2px; height: 2px; border-radius: 2px; background: currentColor; opacity: 0.8; transform-origin: left; animation: seg-busy 1.1s ease-in-out infinite; }
@keyframes seg-busy { 0%, 100% { transform: scaleX(0.15); } 50% { transform: scaleX(1); } }
.fig-loading { position: relative; align-self: stretch; width: 100%; min-height: 160px; }
.zslider { width: 70px; accent-color: var(--fp-accent); vertical-align: middle; cursor: pointer; }
.stats-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm, 12px); margin: 6px 0 4px; }
.stats-table th { text-align: right; font-size: var(--fs-xs, 11px); letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #6b7684); padding: 2px 6px; }
.stats-table td { text-align: right; padding: 3px 6px; font-variant-numeric: tabular-nums; border-top: 1px solid var(--theme--border-color-subdued, #eef1f5); }
.stats-table td:first-child { text-align: left; color: var(--theme--foreground-subdued, #6b7684); font-weight: 600; white-space: nowrap; }
.stat-bad { color: #dc2626; font-weight: 700; }
.stats-win { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #98a2b3); }
.stats-win .linkbtn { float: none; margin-left: 8px; }
.stats-rpm { margin-top: 2px; }
.cutting-map select { margin-left: 4px; }
.stats-compute { margin-top: 4px; }
.acc-head {
	display: flex; align-items: center; gap: 4px; width: 100%; text-align: left;
	background: none; border: 0; cursor: pointer; font: inherit;
	font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #98a2b3); margin: 6px 0 4px; padding: 6px 0 0;
	border-top: 1px solid var(--theme--border-color-subdued, #eef1f5);
}
.acc-head:hover { color: var(--theme--foreground, #1e293b); }
.filt-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.filt-row .chk { flex: 1 1 auto; }
.filt-row input, .filt-row select { width: 60px; font: inherit; font-size: var(--fs-sm, 12px); padding: 3px 6px; border-radius: 7px; border: 1px solid var(--theme--border-color-subdued, #e7ebf0); background: var(--theme--background, #fff); color: inherit; }
.filt-row select { width: auto; }
.filt-harm { display: flex; gap: 8px; margin: 2px 0 6px 20px; }
.filt-harm .chk { font-size: var(--fs-sm, 12px); }
.filt-actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.prof-sel { flex: 1 1 auto; font: inherit; font-size: var(--fs-sm, 12px); padding: 5px 8px; border-radius: 8px; border: 1px solid var(--theme--border-color-subdued, #e7ebf0); background: var(--theme--background, #fff); color: inherit; }
/* compare: two square viewports sharing the FRM area (side-by-side; stacked on mobile) */
.frm-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; height: 100%; min-height: 0; }
.frm-compare.stacked { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
.frm-compare > * { min-width: 0; min-height: 0; }
.zsel { font: inherit; font-size: var(--fs-xs, 11px); font-weight: 650; padding: 3px 7px; border-radius: 8px; cursor: pointer;
	border: 1px solid var(--theme--border-color, #d1d9e6); background: var(--theme--background, #fff); color: var(--theme--foreground, #334155); }
.frm-img { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; min-width: 0; min-height: 220px; overflow: hidden; }
.frm-img img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; border-radius: 8px; border: 1px solid var(--theme--border-color-subdued, #e7ebf0); }
.layout.stacked .frm-img { aspect-ratio: 1 / 1; min-height: 0; flex: 0 0 auto; }
.frm-img > .frm-cloud, .frm-img > .frm-octree { align-self: stretch; }

.tbtn:disabled { opacity: 0.45; cursor: not-allowed; }

/* Live badge + collapse chevrons */
.live-badge { margin-left: 8px; font-size: var(--fs-xs, 11px); font-weight: 800; letter-spacing: 0.06em; color: #7c3aed;
	background: color-mix(in srgb, #7c3aed 12%, transparent); padding: 2px 7px; border-radius: 99px; }
/* "Save crop as official" affordance — only appears once the handles have been moved (cropDirty). */
.crop-save { margin-left: 8px; font-size: var(--fs-xs, 11px); font-weight: 700; color: var(--fp-accent); cursor: pointer;
	background: color-mix(in srgb, var(--fp-accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--fp-accent) 45%, transparent);
	padding: 2px 8px; border-radius: 99px; }
.crop-save:hover { background: color-mix(in srgb, var(--fp-accent) 22%, transparent); }
.crop-confirm { margin-left: 8px; font-size: var(--fs-xs, 11px); font-weight: 700; color: var(--theme--foreground, #e2e8f0); display: inline-flex; align-items: center; gap: 6px; }
.crop-confirm .cc-yes, .crop-confirm .cc-no { font-size: var(--fs-xs, 11px); font-weight: 700; cursor: pointer; padding: 2px 8px; border-radius: 99px; border: 1px solid transparent; }
.crop-confirm .cc-yes { color: var(--fp-accent-ink); background: var(--fp-accent); }
.crop-confirm .cc-yes:disabled { opacity: 0.6; cursor: default; }
.crop-confirm .cc-no { color: var(--theme--foreground-subdued, #94a3b8); background: transparent; border-color: color-mix(in srgb, currentColor 40%, transparent); }
.crop-msg { margin-left: 8px; font-size: var(--fs-xs, 11px); font-weight: 700; color: #22c55e; }
.collapsebtn, .chevbtn {
	display: inline-flex; align-items: center; justify-content: center; border: 0; cursor: pointer; padding: 1px;
	margin-left: 4px; color: var(--theme--foreground-subdued, #94a3b8); background: transparent; border-radius: 6px;
}
.chevbtn { margin-left: 0; margin-right: 2px; }
.collapsebtn:hover, .chevbtn:hover { background: var(--theme--background-subdued, #eef2f7); color: var(--theme--foreground, #1e293b); }
.expandbtn {
	display: inline-flex; align-items: center; gap: 3px; align-self: flex-start; font: inherit; font-size: var(--fs-xs, 11px); font-weight: 700;
	cursor: pointer; padding: 5px 10px; border-radius: 9px; margin-bottom: 2px;
	color: var(--theme--primary, #1d4ed8); background: color-mix(in srgb, var(--theme--primary, #1d4ed8) 10%, transparent);
	border: 1px solid color-mix(in srgb, var(--theme--primary, #1d4ed8) 22%, transparent);
}
.fold-restore { display: flex; gap: 6px; flex: 0 0 auto; }
.ih-actions { display: inline-flex; align-items: center; gap: 4px; }
.card.info.collapsed { padding-bottom: 12px; }
.card.info.collapsed .info-head { margin-bottom: 0; }

/* Live-mode editable metadata + plotting settings */
.linkbtn { border: 0; background: transparent; cursor: pointer; font: inherit; font-size: var(--fs-xs, 11px); font-weight: 700;
	color: var(--theme--primary, #1d4ed8); text-transform: none; letter-spacing: 0; float: right; padding: 0; }
.edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.edit-grid label { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-xs, 11px); font-weight: 700;
	letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #6b7684); }
.edit-grid label.wide { grid-column: 1 / -1; }
.edit-grid label.chk { flex-direction: row; align-items: center; gap: 6px; text-transform: none; letter-spacing: 0; font-size: var(--fs-sm, 12px); }
.edit-grid .u { font-weight: 500; color: var(--theme--foreground-subdued, #a4adba); text-transform: none; }
/* The qualifier on a section heading ("as specified", "this capture") is what distinguishes two
   groups that carry the same quantities from different records -- quieter than the heading, but
   it has to stay readable, so it is not dimmed any further than the heading already is. */
.stat-sep .u { font-weight: 400; opacity: 0.85; }
/* These tiles now only appear when the capture disagrees with the operation record (or is the
   only source), so they are a discrepancy to look at, not background reference. */
.stat.mismatch { border-color: var(--theme--primary, #1d4ed8); }
.stat.mismatch .s-lab .u { font-weight: 400; opacity: 0.8; }
.edit-grid input[type="number"], .edit-grid input[type="text"], .edit-grid select, .edit-grid textarea, .render-row input {
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; text-transform: none; letter-spacing: 0; padding: 5px 8px;
	border: 1px solid var(--theme--border-color, #d1d9e6); border-radius: 8px; background: var(--theme--background, #fff);
	color: var(--theme--foreground, #1e293b); width: 100%; box-sizing: border-box;
}
/* The BOX carries the border, not the input, so the trailing unit reads as part of one control
   (same construction as RecordingOptions.vue's .unit-box on the Record page). */
.edit-grid .unit-box { display: flex; align-items: center; border: 1px solid var(--theme--border-color, #d1d9e6); border-radius: 8px; background: var(--theme--background, #fff); }
.edit-grid .unit-box:focus-within { border-color: var(--theme--primary, #1d4ed8); }
.edit-grid .unit-box input { flex: 1 1 auto; min-width: 0; border: none; background: transparent; border-radius: 0; }
.edit-grid .unit-box input:focus { outline: none; }
.edit-grid .unit-box input.modified { border: none; box-shadow: none; }
.edit-grid .unit-box:has(input.modified) { border-color: var(--theme--primary, #1d4ed8); box-shadow: inset 0 0 0 1px var(--theme--primary, #1d4ed8); }
.edit-grid .unit-box .unit { flex: 0 0 auto; padding-right: 8px; font-size: var(--fs-xs, 11px); font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--theme--foreground-subdued, #a4adba); }
.edit-grid textarea { resize: vertical; min-height: 44px; }
.edit-grid input:disabled { opacity: 0.5; cursor: not-allowed; }
.edit-grid input.modified, .edit-grid textarea.modified { border-color: var(--theme--primary, #1d4ed8); box-shadow: inset 0 0 0 1px var(--theme--primary, #1d4ed8); }
.speed-row { display: flex; gap: 6px; }
.speed-row select { flex: 1 1 auto; } .speed-row input { flex: 0 0 82px; }
.render-row { display: flex; align-items: flex-end; gap: 8px; }
.render-row label { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-xs, 11px); font-weight: 700;
	letter-spacing: 0.01em; color: var(--theme--foreground-subdued, #6b7684); flex: 1 1 auto; }
.processbtn {
	display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 750; cursor: pointer;
	padding: 7px 14px; border-radius: 9px; color: var(--fp-accent-ink); background: var(--fp-accent); border: 0; white-space: nowrap;
}
.processbtn:disabled { opacity: 0.6; cursor: progress; }
.applybtn {
	display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 750; cursor: pointer;
	padding: 7px 14px; border-radius: 9px; color: #6d28d9; background: transparent; border: 1.5px solid #7c3aed; white-space: nowrap;
}
.applybtn:disabled { opacity: 0.5; cursor: not-allowed; }
.render-msg { margin-top: 7px; font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #6b7684); font-style: italic; }
.changes-backdrop {
	position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55); display: grid; place-items: center; z-index: 200;
}
.changes-dialog {
	width: min(460px, 92vw); max-height: 80vh; overflow-y: auto; background: var(--theme--background, #fff);
	border: 1px solid var(--theme--border-color, #d1d9e6); border-radius: 14px; padding: 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.35);
}
.changes-dialog h3 { margin: 0 0 10px; font-size: var(--fs-lg, 15px); font-weight: 750; color: var(--theme--foreground, #1e293b); }
.changes-list { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin: 0 0 14px; font-size: var(--fs-md, 13px); }
.changes-list dt { font-weight: 700; color: var(--theme--foreground-subdued, #6b7684); }
.changes-list dd { margin: 0; color: var(--theme--foreground, #1e293b); font-variant-numeric: tabular-nums; }
.changes-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.cd-no, .cd-yes { font: inherit; font-size: var(--fs-md, 13px); font-weight: 700; cursor: pointer; padding: 6px 14px; border-radius: 8px; border: 1px solid transparent; }
.cd-no { color: var(--theme--foreground-subdued, #6b7684); background: transparent; border-color: var(--theme--border-color, #d1d9e6); }
.cd-yes { color: var(--fp-accent-ink); background: var(--fp-accent); }
.cd-yes:disabled, .cd-no:disabled { opacity: 0.6; cursor: default; }
</style>
