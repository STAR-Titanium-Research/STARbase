<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onBeforeUnmount, provide, reactive, ref, shallowReactive, watch } from 'vue';
import { GridLayout, GridItem } from 'grid-layout-plus';
import { useRoute, useRouter } from 'vue-router';
import './force.css';
import ForceLists, { type OpCard } from './ForceLists.vue';
import ForceOpColumn, { type OpTab } from './ForceOpColumn.vue';
import ForcePanel from './ForcePanel.vue';
import ForceSignals from './ForceSignals.vue';
import ForceFrm from './ForceFrm.vue';
import { FORCE_CTX } from './forceCtx';
import { RIGHT_DEFAULT, layoutColumns, layoutMode, startingGrid, type RPanel, type RPanelType } from './forceLayout';
import type { HoverSource } from './chartHover';
import { downloadFailureMessage } from './downloadError';
import { pickMode, type FrmMode } from './frmMode';
import { perKeyComputed } from './perKeyComputed';
import { frmOverlay, sameStage, stageInfo, type LoadStage, type OverlayMode, type StageInfo } from './loadStage';
import { createLoadToken } from './loadToken';
import { createActivationQueue, createOpGuard } from './opGuard';
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue';
import PlotHelp from './PlotHelp.vue';
import { formatPointInfo, recentreWindow, type PointInfo, type PointMenuEvent } from './cloudPick';
import WearTrend from './WearTrend.vue';
import type { SpeedMode } from './liveCloud';
import { axisAutoLimits } from './liveCloud';
import { defaultScale, withAutoRange, withOpenDisplay, type ColorScale } from './colorScale';
import { useAutoColorScale } from './autoColorScale';
import { histogramFrom, type Histogram } from './histogram';
import { cacheGet, cachePut, decimateCache, parseCache, type Cache } from './liveCache';
import { alignMeasuredRho, measuredRhoSpan, type TurningSpiralParams } from './path';
import { activeFindings, diagnose, worstSeverity, type Finding } from './metadataDoctor';
import { computeSignalStats, resolveStatsWindow, type SignalStats } from './signalStats';
import { statsCsvColumns } from './statsCsv';
import { DEFAULT_AXIS_MAP, axisMapKey, computeCuttingMetrics, formatAxisMap, opKindFromSubtype, parseAxisMap, removeLegacyAxisMap, resolveAxisMap, usesSpiralDiameter, writeAxisMapForSubtype, type Metric } from './cuttingMetrics';
import { meanRpm } from './filterResponse';
import { type FilterChain, bakeBlockedReason, chainActive, chainsEqual, cloneChain, defaultChain, fetchFiltered, fetchFilteredFft, stagesOn } from './filterChain';
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
// DESIGN.md 5b series slots: blue / orange / teal (the --d1-series tokens, with their light values as fallback)
const AXIS_COLOR: Record<Axis, string> = { Fx: 'var(--d1-series-1, #2a78d6)', Fy: 'var(--d1-series-2, #eb6834)', Fz: 'var(--d1-series-3, #1baf7a)' };

const loading = ref(true);
const rows = ref<any[]>([]);

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
	{ key: 'spectrogram', label: 'Spectrogram', title: 'Time × frequency heatmap' },
	{ key: 'waterfall', label: 'Waterfall', title: 'Stacked spectra over time' },
];
const SPECTRAL_MODES = ['psd', 'spectrogram', 'waterfall'] as const;
const isSpectral = computed(() => (SPECTRAL_MODES as readonly string[]).includes(chartMode.value));
const hoverIndex = ref<number | null>(null);   // shared across the 3 charts
// Charts get this instead of the number so a hover move redraws only their crosshair (#100).
const hoverSource: HoverSource = { index: hoverIndex };
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
// The operation column shows one tab at a time (ForceOpColumn): cut parameters | display | signal
// filters | signal statistics | cutting metrics.
const openPanel = ref<OpTab>('cut');
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
// "Preview on charts" (Signal filters tab): draw the working chain over the raw signal while it is tuned.
const previewOn = ref(true);
const previewing = computed(() => filtersOpen.value && previewOn.value);
watch(filtersOpen, (open) => { if (open) previewOn.value = true; });
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
const compareOn = computed(() => liveOn.value && chainActive(workChain.value) && previewing.value);
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
// A dot on the Signal filters tab: the working chain differs from the saved one; the badge counts its stages.
const chainDirty = computed(() => !chainsEqual(workChain.value, savedChain.value ?? defaultChain()));
const stagesOnCount = computed(() => stagesOn(workChain.value));
const filterBaked = computed(() => detail.value?.filter_baked === true);
const bakeBlocked = computed(() => bakeBlockedReason(detail.value));
const bakedChain = computed<FilterChain | null>(() => (filterBaked.value ? savedChain.value : null));
const appliedLight = computed<boolean>(() => !!savedChain.value && !filterBaked.value);
// The single filtered pane: a light-applied op renders one Lite cloud recomputed from filteredCache
// (the compare panes only appear while the Filters panel is open for tuning). Baked ops need no solo
// pane — their loaded cache is already filtered, so the normal Lite pane shows the filtered signal.
const filteredSoloOn = computed(() => liveOn.value && !previewing.value && appliedLight.value && filteredCache.value != null);

async function loadProfiles() {
	try { profiles.value = (await api.get('/items/filter_profiles', { params: { fields: ['id', 'name', 'chain'], sort: 'name', limit: 100 } })).data.data ?? []; }
	catch { profiles.value = []; }
}
// Which chain the Lite filtered preview reflects: the editable workChain while the Filters panel is
// open (live tuning + raw|filtered compare), else the op's saved chain when it's light-applied (the
// single filtered pane persists after leaving the panel). Null => nothing to preview.
function previewChain(): FilterChain | null {
	if (previewing.value) return workChain.value;
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
watch([workChain, () => detail.value?.live_cache_file, previewing, () => appliedLight.value, () => liveOn.value, axis, chartMode], () => {
	// Preview whenever we're tuning (panel open) OR the op is light-applied and Lite is showing it.
	if (!previewing.value && !(appliedLight.value && liveOn.value)) {
		if (!compareOn.value) filteredCache.value = null;   // drop the stale filtered cloud
		return;
	}
	clearTimeout(previewTimer);
	previewTimer = window.setTimeout(runPreview, 400);
}, { deep: true });
watch(() => detail.value?.id, () => {
	stopHostPolls();   // a poll started for the previous op must not report into this one
	workChain.value = cloneChain(savedChain.value);
	previewOn.value = true;
	filteredCache.value = null; filterErr.value = null; filterFftOverlay.value = null;
});
function applyProfile(id: string) {
	const p = profiles.value.find((x) => x.id === id);
	if (p?.chain) workChain.value = cloneChain(mergeChain(typeof p.chain === 'string' ? JSON.parse(p.chain) : p.chain));
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
	const chain = cloneChain(workChain.value);
	filterErr.value = null;
	detail.value = { ...detail.value, filter_chain: chain, filter_baked: false };   // optimistic — solo pane shows now
	try { await api.patch(`/items/machining_force_analysis/${d.id}`, { filter_chain: chain, filter_baked: false }); }
	catch (e: any) { filterErr.value = e?.response?.status === 403 ? 'Not permitted to save this filter.' : (e?.message || 'save failed'); }
	previewOn.value = false;   // stop tuning: the compare panes collapse to the single filtered pane
}
async function bakeFilters() {
	const d = detail.value;
	if (!d?.id || baking.value) return;
	// No archive .mat to reprocess: a 'pending' PATCH would make the orchestrator error the row out.
	const blocked = bakeBlockedReason(d);
	if (blocked) { filterErr.value = blocked; return; }
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
	// Without an archive .mat a bake-clear can't reprocess either; just drop the saved chain.
	if (!filterBaked.value || bakeBlockedReason(d)) {
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
	if (bakeBlockedReason(d)) return;   // never PATCH status 'pending' for a row with no .mat
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
// The one loading overlay for the FRM area (#191). The mode is the view actually mounted (Full
// without an octree falls back), mirroring the v-if chain in the template.
const frmShownMode = computed<OverlayMode>(() => octreeOn.value ? 'full' : (compareOn.value || filteredSoloOn.value || liveOn.value) ? 'lite' : 'figure');
const frmLoadOverlay = computed(() => frmOverlay(frmShownMode.value, frmStage.value?.stage ?? null, frmLoading.value, figStage.value));
const frmCache = new Map<string, string>();

// ---------------------------------------------------------------- layout state
// The columns have fixed widths (DESIGN.md 5b, layoutMode / layoutColumns); only the panel grid right of
// them is arranged by the user. LAYOUT_KEY keeps the view type (Figure / Lite / Full) between visits;
// the column widths and folds that older versions saved there are ignored.
const LAYOUT_KEY = 'd1-force-dashboard-layout-v1';

(function loadLayout() {
	try {
		const raw = localStorage.getItem(LAYOUT_KEY);
		if (!raw) return;
		const v = JSON.parse(raw);
		if (v.frmMode === 'figure' || v.frmMode === 'lite' || v.frmMode === 'full') chooseMode(v.frmMode);
	} catch { /* ignore malformed/absent saved layout */ }
})();
// Persist Live so returning to the dashboard keeps the interactive FRM cloud instead of silently
// dropping back to the static PNG. (liveOn still requires a live cache on the selected op, so ops
// without one safely show the PNG.)
watch(frmMode, () => {
	try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ frmMode: frmMode.value })); } catch { /* ignore */ }
});

const rightAreaEl = ref<HTMLElement | null>(null);

// The page reacts to its own width, not the viewport's (Directus reserves side chrome).
const layoutEl = ref<HTMLElement | null>(null);
const layoutW = ref(1400);
const mode = computed(() => layoutMode(layoutW.value));
const stacked = computed(() => mode.value === 'stacked');
const gridCols = computed(() => layoutColumns(mode.value));

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
// The area right of the operation column is a grid-layout-plus grid of panels (like the recording view);
// the default puts the FRM in the centre column and Signals on the right. The lists and the operation
// column stay docked at the left; only the panels are flexible.
// Per-instance panel state: a Signals panel carries its own selected channels + RPM toggle so
// duplicated panels can differ (e.g. one showing only Fz next to one showing Fx/Fy).
const RIGHT_KEY = 'd1-force-right-layout-v2';
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
	let saved: unknown = null;
	try { saved = JSON.parse(localStorage.getItem(RIGHT_KEY) || 'null'); } catch { /* ignore */ }
	// the page used to open with Signals left of the FRM: an untouched saved default moves to the new one
	return startingGrid(saved, Object.keys(R_META));
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
					'operation_id.sample_id.form', 'operation_id.sample_id.manufactured_date',
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
				material: s.material_id?.common_name, owner: s.owner_person_id?.full_name, form: s.form, manufactured: s.manufactured_date, ops: [] as any[] };
			map.set(s.sample_id, e);
		}
		e.ops.push(r);
	}
	const arr = [...map.values()];
	arr.sort(bySampleCode);
	return arr;
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

// Plot readiness of an operation row (mirrors the FAST dashboard). Green = a
// plottable FRM cache exists · Blue = processing · Yellow = octree-only (no live cache) ·
// Red = failed or no plot data.
// `label` is the worded badge, `hint` its tooltip.
function frmQuality(o: any): { level: string; label: string; hint: string } {
	if (o?.status === 'pending' || o?.status === 'processing') return { level: 'blue', label: 'Processing…', hint: 'Being processed on the host' };
	if (o?.live_cache_file) return { level: 'green', label: 'FRM ready', hint: 'A live cache exists: the interactive FRM can be plotted' };
	if (o?.octree_status === 'done') return { level: 'yellow', label: 'Octree only', hint: 'Octree only (no live cache)' };
	if (o?.status === 'error') return { level: 'red', label: 'Failed', hint: 'Processing failed' };
	return { level: 'red', label: 'No plot data', hint: 'No plot data' };
}

// ---- Metadata Doctor ------------------------------------------------------------------------
// Metadata health is a DIFFERENT axis from frmQuality above: that one answers "is this plottable",
// this one "do the .mat and D1 agree". They get separate markers on purpose — folding a feed
// conflict into "no plot data" would lose the distinction the user needs in order to act.
//
// The noisy check is opt-in (see metadataDoctor.ts): docs/force-file-standards.md §7 records that
// dates in filenames and pass codes are frequently wrong — so it is informational and off until
// asked for.
const DOCTOR_OPTIONAL = [
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

// The Operations list of column 1: one card per operation, with its worded badges.
const opCards = computed<OpCard[]>(() => displayedOps.value.map((o) => {
	const q = frmQuality(o), d = doctorQuality(o);
	return {
		id: o.id, row: o, code: o.operation_id?.pass_code || '—', latest: o.id === latestRowId.value,
		sub: [filterSampleId.value ? '' : sampleOf(o)?.sample_code, fmtDate(o.operation_id?.operation_date), `Fz ${fmt(o.peak_fz)} N`].filter(Boolean).join(' · '),
		ready: q, issue: d ? { level: d.level, count: d.count, hint: d.label } : null,
	};
}));

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
		document.querySelectorAll('.fp-lists .fp-card.active').forEach((el) => el.scrollIntoView({ block: 'nearest' }));
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
					// Needed to seed the editable cutting-parameter boxes (seedMetaFromDetail) and by the
					// Metadata Doctor's feed/DoC/Vc pairs.
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
					'directus_files_id.id', 'directus_files_id.filesize', 'live_cache_file', 'live_render_points', 'pulses_per_rev', 'inner_diameter', 'outer_diameter', 'filter_chain', 'filter_baked',
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
// notes) — the plotting view previously showed these read-only. Combined with the crop
// save into one dialog (see saveChanges() below). Machine/Method (equipment_id/method_id
// relations) stay read-only: editing them needs option-list fetches from collections not
// otherwise touched in this package. The operation code is NOT edited or composed here: the
// database builds it (trigger mfg_op_set_code) and saveChanges() reads it back after a save.
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
// The operation record's own workpiece diameter. NOT the same field as the "Spiral Ø" field
// under Cut parameters (that one is machining_force_analysis.outer_diameter, a geometry override for the spiral):
// this is the operation's recorded stock diameter.
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
// Operation code and Sequence are NOT user-editable (see edit-grid below): the code is built by the
// database from the operation's fields, and Sequence is the key archive .mat filenames are matched
// to an operation by (see docs/superpowers/specs .mat-operation-linking notes) — hand-editing it
// here would silently desync that link, so it stays fixed at whatever seedMetaFromDetail() loaded.
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
		|| editOutcomeNotes.value !== srcMeta.outcomeNotes;
});

// A dot on the Cut parameters tab: an edited cut field or operation record field. The same fields
// outline themselves in the form; Reset puts the cut fields back to what the capture was loaded with.
const cutModified = computed(() => !near(editFeed.value, srcCut.feed) || !near(editDiam.value, srcCut.diam) || !near(editInnerDiam.value, srcCut.inner)
	|| !near(editPpr.value, srcCut.ppr) || !near(editRate.value, srcCut.rate));
const cutEdited = computed(() => cutModified.value || metaDirty.value);

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
// Adopting Feed/DoC/Vc can change the operation code the database builds on save; the dashboard
// never writes pass_code itself — saveChanges() reads the stored code back after the PATCH.
function adoptFinding(f: Finding) {
	if (!canAdopt(f)) return;
	const t = ADOPT_TARGETS[f.field!];
	t.ref.value = f.matValue as number;
	// Reveal the metadata box holding the field we just seeded, so the pending edit is visible
	// rather than silently staged behind a folded accordion.
	openPanel.value = 'cut';
}
function applyFix(f: Finding) {
	if (f.fix === 'adopt') return adoptFinding(f);
	if (f.fix === 'crop') return startCropFix();
	if (f.fix === 'link') return openOpForm();
}
// No auto-fix for a bad crop: the right window is a human judgement. Put the crop handles in front
// of the user instead — Lite is the only mode that recomputes the crop live (see onCropEdit).
function startCropFix() {
	if (liveAvailable.value) chooseMode('lite');
	document.querySelector('[data-panel-id] .charts')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
		return { id: s.sample_id, sample_code: s.sample_code, material: s.material, nickname: s.nickname, form: s.form, owner: s.owner, manufactured: s.manufactured, ops: s.ops.length };
	}
	return null;
});

// What the operation column always shows above its tabs.
const ready = computed(() => (detail.value ? frmQuality(detail.value) : null));
const recordedText = computed(() => fmtDateTime(detail.value?.trigger_time) || fmtDate(op.value?.operation_date) || '—');
const machineText = computed(() => op.value?.equipment_id?.equipment_name || '—');

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

// The sample, operation and capture details that are not always visible: the Cut parameters tab folds
// them under "Sample and capture details".
const moreRows = computed<[string, string][]>(() => {
	const d = detail.value;
	if (!d) return [];
	const si = sampleInfo.value;
	const rows: Array<[string, any]> = [
		['Material', si?.material], ['Nickname', si?.nickname], ['Form', si?.form], ['Owner', si?.owner],
		['Made', si?.manufactured ? fmtDate(si.manufactured) : ''], ['Analysed ops', si?.ops],
		['Method', op.value?.method_id?.method_name],
		['Sample rate', d.sample_rate ? `${(d.sample_rate / 1000).toFixed(1)} kHz` : '—'],
		['Dyno gain', d.dyno_gain != null ? `${fmt(d.dyno_gain)} N/V` : '—'],
		['Raw points', d.n_raw != null ? Number(d.n_raw).toLocaleString() : '—'],
		['File version', d.file_version != null ? String(d.file_version) : '—'],
		['File size', fmtBytes(d.directus_files_id?.filesize)],
	];
	return rows.filter(([, v]) => v != null && v !== '' && v !== '—').map(([k, v]) => [k, String(v)]);
});
const captureOpen = ref(false);

// The user picking a view type. Choosing Lite switches the Signals charts back to Force, where the
// crop handles are. Only a deliberate choice does that: this used to be a watcher on frmMode, so the
// automatic re-pick when a different file loaded reflowed the whole layout (#94).
function chooseMode(m: FrmMode) {
	preferredMode.value = m;
	frmMode.value = m;
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
	return patch;
}
// What the confirmation dialog shows before writing — every changed field as old -> new, plus
// the crop window (if dirty). The operation code has no row: the database builds it on save.
// Sequence has no row either: it's not user-editable (see edit-grid), so it never differs from srcMeta.
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
			const { data } = await api.patch(`/items/manufacturing_operations/${o.operation_id}`, patch, {
				params: { fields: ['pass_code'] },
			});
			Object.assign(o, patch);   // optimistic update of the edited fields — op.value is detail.value.operation_id
			// The code the database built from the saved fields. No data (e.g. a 204 when the user may no
			// longer read the row) keeps the old code shown.
			if (data?.data && 'pass_code' in data.data) o.pass_code = data.data.pass_code;
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
const PEAK_FIELD: Record<string, string> = { Fx: 'peak_fx', Fy: 'peak_fy', Fz: 'peak_fz' };
// Charts for one Signals panel instance — its own selected channels + RPM toggle (Force/FFT mode
// stays shared, since it's tied to the filter preview + FRM). At least one axis is kept on.
function buildChartsFor(item: RPanel) {
	const d = detail.value;
	const sel = (item.channels && item.channels.length ? item.channels : AXES) as readonly Axis[];
	const secondXLabel = 'Radius (mm)';
	const base = AXES.filter((a) => sel.includes(a)).map((a) => (
		effectiveMode.value === 'force'
			? { key: a, title: `${a} · force`, kind: 'env' as const, data: d?.series?.[a], color: AXIS_COLOR[a], xUnit: 's', yUnit: 'N',
				cropStart: activeCrop.value?.start, cropEnd: activeCrop.value?.end, peak: d?.[PEAK_FIELD[a]],
				compare: compareSeriesFor(a),
				secondXValues: radialValuesFor(d?.series?.[a]?.t), secondXLabel }
			: { key: a, title: `${a} · spectrum`, kind: 'line' as const, data: d?.fft?.[a], color: AXIS_COLOR[a], xUnit: 'Hz', yUnit: 'N', logY: true }
	));
	if (effectiveMode.value === 'force' && item.rpm) {
		base.push({ key: 'RPM', title: 'RPM', kind: 'env', data: detail.value?.series?.RPM, color: 'var(--theme--foreground-subdued, #64748b)', xUnit: 's', yUnit: 'rpm',
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

// Chain the spectral views reflect: the live-tuned/applied filter when present, else raw.
// The rotation speed the filter service notches at: the mean of the cache's rpm channel (not the
// editable plot-model rpm). cacheGet() is not reactive, so this reads cacheEpoch.
const cacheMeanRpm = computed(() => {
	void cacheEpoch.value;
	const c = detail.value?.live_cache_file ? cacheGet(detail.value.live_cache_file) : null;
	return c ? meanRpm(c.rpm) : null;
});
// The FFT chart whose trace is the filtered one (the filter panel's preview, on the active axis).
const fftFiltered = (c: { kind: string; key: string }) => chartMode.value === 'fft' && previewing.value && c.kind === 'line' && c.key === axis.value;
const specChain = computed<FilterChain>(() => previewChain() ?? savedChain.value ?? defaultChain());
// The chain whose stop bands the spectra shade ("Filter bands"), and how many of its stages are on.
const fftChain = computed(() => (chainActive(specChain.value) ? specChain.value : null));
const activeStages = computed(() => stagesOn(specChain.value));
const compareOpen = ref(false);   // the Compare bar of the Signals group, opened from its ⋯ menu
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
// A host whose download fails (expired session, file gone) rejects; that shows under the FRM image.
const downloadMsg = ref<string | null>(null);
// The message is about the file just tried: a different operation or axis starts clean.
watch(() => [detail.value?.id, axis.value], () => { downloadMsg.value = null; });
function downloadFile(fileId: string) {
	downloadMsg.value = null;
	void Promise.resolve()
		.then(() => host.downloadAsset(fileId))
		.catch((e) => { downloadMsg.value = downloadFailureMessage(e); });
}

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

// Everything the operation column's tabs, the Signals and FRM panels read or edit, in one bundle (forceCtx.ts).
// Shallow, so a member that is a ref stays that ref (a child's v-model writes straight back to it).
provide(FORCE_CTX, shallowReactive({
	AXES, AXIS_COLOR, AXIS_MAP_STANDARD, CHART_MODES, DIFF_H, DIFF_W, STAT_AXES, activeStages, addCompare, addsInfoOverOp, appliedLight, applyFilter,
	applyProfile, axis, axisMapSel, axisMapSubtype, bakeBlocked, bakeFilters, bakedChain, baking, buildOctree, buildingOctree, cacheMeanRpm,
	captureOpen, chainDirty, changeSummary, changesDialogOpen, chartMode, chartsFor, chooseMode, clearCompare, clearFilter, cloudProps, colorDomainHi,
	colorDomainLo, colorHistogram, colorScale, compareBusy, compareCandidates, compareItems, compareOn, compareOpen, comparePickerOpen, compareRefId,
	compareRefLabel, compareView, computeStats, copyStatsCsv, cropDirty, cropSavePrompt, cropSavedMsg, cropSaving, cutEdited, cutModified, cutTip,
	cutVal, cutting, cuttingMapText, detail, diffOn, diffResult, diffSpark, displayedPoints, downloadFrm, downloadMsg, downloadStatsCsv, editDiam,
	editFeed, editInnerDiam, editOpAxialDoc, editOpCoolant, editOpCuttingSpeed, editOpFeedMmPerRev, editOpNewEdge, editOpSubtype, editOpWorkpieceDiam,
	editOperatorName, editOutcomeNotes, editPpr, editRate, editRateKHz, editRpm, editVc, effectiveMode, fftChain, fftFiltered, filterBusy, filterErr,
	filterFftOverlay, filterSkipped, filteredAuto, filteredCache, filteredColorScale, filteredSoloOn, fmtCutTime, fmtDate, fmtDelta, fmtOrDash, fmtPts,
	fmtStat, frmBusy, frmCloudRef, frmLoadOverlay, frmLoading, frmMode, frmOctreeRef, frmStage, frmUrl, fullResPoints, gridActive, gridAvailable,
	gridFidelityPct, gridFull, hasChanges, hoverIndex, hoverSource, hoverTime, isSpectral, linkMsg, liveAvailable, liveOn, loadingDetail, locked,
	machineText, markTime, metaDirty, moreRows, near, numDiffers, numOrNull, octreeAvailable, octreeBudgetCap, octreeMinNodePx, octreeMsg, octreeOn,
	octreeSampleCache, onAxisMapChange, onChartZoom, onClimits, onCloudLoaded, onCropEdit, opLabel, openChartMenu, openMenu, openOpForm, openPanel,
	openPointMenu, openSampleForm, plotStride, pointSize, previewOn, processFullRes, profiles, radialFetchBusy, rawDecimatedCache, ready, recordedText,
	rectZoomTool, removeCompare, renderMsg, renderPoints, rendererHistogram, rendering, resetLive, resetZoom, resolutionPct, sampleInfo, sampleOf,
	saveCropAsOfficial, saveProfile, savedChain, seedCutFromDetail, seedMetaFromDetail, setAxis, sigStats, specChain, speedMode, srcCut, srcMeta,
	stacked, stagesOnCount, statsBusy, statsCacheMb, statsCopied, statsCopyFailed, statsErr, toggleCompareRef, toggleItemAxis, workChain, zScale,
	zSeries, zoomEnd, zoomStart, zoomed,
}));
</script>

<template>
	<private-view title="Force Analysis">
		<div class="fd fp" :class="{ dense: host.dense }" @click="rightAddOpen = false">
			<section class="bar">
				<span class="fp-dim">{{ rows.length }} op{{ rows.length === 1 ? '' : 's' }} · {{ samples.length }} sample{{ samples.length === 1 ? '' : 's' }}</span>
				<span class="grow"></span>
				<div class="pt-add" @click.stop>
					<!-- Add + each panel's own close is the whole panel menu (as on the Record page). -->
					<button class="fp-btn" aria-haspopup="menu" :aria-expanded="rightAddOpen" title="Add a panel" @click.stop="rightAddOpen = !rightAddOpen"><v-icon name="add" x-small /> Add panel</button>
					<div v-if="rightAddOpen" class="pt-menu" role="menu" @click.stop>
						<button role="menuitem" @click="addRightPanel('signals')"><v-icon name="insights" x-small /> Signals</button>
						<button role="menuitem" @click="addRightPanel('frm')"><v-icon name="fingerprint" x-small /> FRM map</button>
						<button role="menuitem" @click="addRightPanel('wear')"><v-icon name="trending_up" x-small /> Wear trend</button>
						<button role="menuitem" @click="addRightPanel('doctor')"><v-icon name="health_and_safety" x-small /> Metadata doctor</button>
					</div>
				</div>
				<button class="fp-btn icon" title="Reset panel layout" aria-label="Reset panel layout" @click="resetRightLayout"><v-icon name="grid_view" x-small /></button>
				<button class="fp-btn icon" title="Gestures and shortcuts" aria-label="Help: gestures and shortcuts" aria-haspopup="dialog" @click="helpOpen = true">?</button>
				<button class="fp-btn" title="Copy a link that reopens this view (cut, mode, axes, zoom, compare set)" :disabled="!selectedRowId" @click="copyViewLink">
					<v-icon name="link" x-small /> {{ linkCopied ? 'Copied' : linkCopyFailed ? 'Copy failed' : 'Copy link' }}
				</button>
			</section>

			<div v-show="loading" class="loading"><v-progress-circular indeterminate /></div>

			<div v-show="!loading" ref="layoutEl" class="layout" :class="{ stacked }"
				:style="{ gridTemplateColumns: gridCols, height: stacked ? 'auto' : availableHeight + 'px' }">
				<!-- COL 1: samples -> operations (a 44px tab on a narrower page) -->
				<ForceLists :samples="samples" :ops="opCards" :selected-sample-id="selectedSampleId" v-model:filter-sample-id="filterSampleId" :selected-row-id="selectedRowId"
					v-model:op-search="opSearch" v-model:issues-only="issuesOnly" :issue-count="doctorFlaggedCount" :folded="mode === 'folded'"
					:selected-code="selectedRowId ? opLabel : null" @select-sample="selectSample" @select-op="selectOp" />

				<!-- COL 2: the operation: identity, icon tabs, Save changes / Open -->
				<ForceOpColumn />

				<!-- COL 3 + 4: the panels (FRM in the centre, Signals on the right by default), arranged on a grid -->
				<div ref="rightAreaEl" class="right-area">
					<GridLayout v-model:layout="rightLayout" class="right-grid" :col-num="stacked ? 1 : 12"
						:row-height="rightRowH" :margin="[10, 10]" :is-draggable="!stacked" :is-resizable="!stacked"
						:vertical-compact="true" :use-css-transforms="true">
						<GridItem v-for="item in rightLayout" :key="item.i" :x="item.x" :y="item.y" :w="item.w" :h="item.h" :i="item.i"
							:data-panel-id="item.i" drag-allow-from=".pg-grip" :min-w="3" :min-h="7">
							<ForceSignals v-if="item.type === 'signals'" :item="item" @close="closeRightPanel(item.i)" />
							<ForceFrm v-else-if="item.type === 'frm'" @close="closeRightPanel(item.i)" />
							<ForcePanel v-else-if="item.type === 'wear'" title="Wear trend" icon="trending_up" @close="closeRightPanel(item.i)">
								<WearTrend :detail="detail" />
							</ForcePanel>
							<!-- Metadata doctor. Two views over the same diagnose() output: the selected
							     operation's findings with their fixes, and a scan of the whole archive. -->
							<ForcePanel v-else-if="item.type === 'doctor'" title="Metadata doctor" icon="health_and_safety" @close="closeRightPanel(item.i)">
								<template #tools>
									<span class="fp-seg" role="group" aria-label="Scope">
										<button :aria-pressed="doctorScope === 'op'" @click="doctorScope = 'op'">This op</button>
										<button :aria-pressed="doctorScope === 'all'" @click="doctorScope = 'all'">All</button>
									</span>
								</template>
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
								<div v-if="!detail" class="fp-empty">Select an operation</div>
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
										<span class="fp-chip">{{ g.rows.length }}</span>
									</div>
									<!-- data-row-id is the ANALYSIS-row id, which is not 1:1 with the pass_code
									     shown: one operation can have more than one .mat, so two rows can
									     carry the same name. Count on this, never on the label. -->
									<button v-for="r in g.rows" :key="r.id" class="doc-oprow" :data-row-id="r.id"
										:class="{ active: selectedRowId === r.id }" @click="selectOp(r)">
										<span class="fp-code">{{ r.operation_id?.pass_code || sampleOf(r)?.sample_code || r.id }}</span>
									</button>
								</div>
							</template>
						</div>
							</ForcePanel>
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
					<p v-if="!changeSummary.length" class="fp-empty">Nothing to save.</p>
					<dl v-else class="changes-list">
						<template v-for="row in changeSummary" :key="row.label">
							<dt>{{ row.label }}</dt>
							<dd>{{ row.from }} → {{ row.to }}</dd>
						</template>
					</dl>
					<div v-if="metaSaveErr" class="fp-err">{{ metaSaveErr }}</div>
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
	padding: 12px 16px 16px;
	container-type: inline-size;   /* size children to the real content width, not the viewport */
}
/* The page's own toolbar: counts on the left, the panel menu, help and Copy link on the right. */
.bar { display: flex; align-items: center; gap: 8px; min-height: 32px; margin-bottom: 10px; flex-wrap: wrap; }
.bar .grow { flex: 1 1 auto; }
.pt-add { position: relative; }
.pt-menu { position: absolute; top: 32px; right: 0; z-index: 40; min-width: 160px; padding: 4px; border-radius: 9px; background: var(--theme--background); border: 1px solid var(--fp-line); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
.pt-menu button { display: flex; align-items: center; gap: 7px; width: 100%; padding: 7px 8px; font: inherit; font-size: var(--fs-sm, 12px); color: var(--theme--foreground); background: transparent; border: 0; border-radius: 6px; cursor: pointer; text-align: left; }
.pt-menu button:hover { background: var(--fp-tile); }

.loading { display: grid; place-items: center; padding: 40px; }

/* Four columns (lists | operation | the panel grid, which holds the FRM and Signals); the measured height is
   exact, so the panels scroll inside and the page does not. */
.layout { display: grid; gap: 12px; align-items: stretch; overflow: hidden; }
.layout.stacked { align-items: start; overflow: visible; }
.layout.stacked :deep(.list) { max-height: 40vh; flex: none; }
.layout.stacked :deep(.fp-lists .stack) { flex: none; }
.layout.stacked :deep(.fp-lists .part) { flex: none; }

/* The panel grid can grow taller than the viewport (adding or moving panels), so it is the scroll container. */
.right-area { min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; }
/* Pull the grid up by its top margin so row-0 panels align with the top of the columns beside it. */
.right-grid { width: 100%; margin-top: -10px; }
.right-grid :deep(.vgl-item__resizer) { z-index: 3; }
.right-grid :deep(.vgl-item--placeholder) { background: color-mix(in srgb, var(--fp-accent) 18%, transparent); border-radius: 12px; }
.layout.stacked .right-grid :deep(.fp-panel) { min-height: 420px; }

/* ---- Metadata doctor body */
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
