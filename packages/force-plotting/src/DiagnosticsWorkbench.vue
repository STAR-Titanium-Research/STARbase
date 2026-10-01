<script setup lang="ts">
// The Diagnostics Workbench: an editable processing pipeline, one or more full-resolution
// spatial views, the signal brush, the cluster table and the selection inspector — each a
// panel you can add, close, resize, rearrange or pop out to its own window, exactly like the
// Record tab (apps/force-app/web/src/record/RecordPage.vue).
//
// The recipe is a client-side object. Editing it debounce-fires POST /diag/preview, whose
// D1AN bytes feed the Signal chart and the Inspector. Each spatial view additionally recomputes
// its spatial step on the framed region at full resolution (see SpatialPanel.vue). The bake is
// the existing diag_status='pending' PATCH flow, emitted upward.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { GridLayout, GridItem } from 'grid-layout-plus';
import SpatialPanel from './SpatialPanel.vue';
import SignalPanel from './SignalPanel.vue';
import ClusterTable from './ClusterTable.vue';
import RecipePanel from './RecipePanel.vue';
import LayerPanel from './LayerPanel.vue';
import WorkbenchPanel from './WorkbenchPanel.vue';
import SelectionInspector from './SelectionInspector.vue';
import BandwidthStrip from './BandwidthStrip.vue';
import InfoTip from './InfoTip.vue';
import { fetchD1an } from './diagAttrs';
import { fetchDiagPreview } from './diagPreview';
import type { ViewportResult, ViewportOp } from './diagViewport';
import { clusterStats, computeStats, workingSetFromD1an } from './selection';
import type { ClusterRow, Selection, WorkingSet } from './selection';
import {
	DEFAULT_RECIPE, firstDerivedIndex, primaryChannelForOp, recipeChannels, recipeProblems,
	recipesEquivalent, type Recipe,
} from './recipeChannels';
import { CHANNEL_HELP, PANEL_HELP } from './diagHelp';
import {
	DIAG_LAYOUT_LS_KEY, DIAG_PANEL_TYPES, loadDiagLayout, newPanelInst, saveDiagLayout,
	type DiagPanelInst,
} from './diagPanels';
import {
	fetchLayers, saveLayer, deleteLayer, layersForRequest, type DiagLayer, type LayerRole,
} from './diagLayers';
import { fetchRecipeLibrary, type SavedRecipe } from './diagRecipes';
import { clusterColorCss } from './clusterPalette';
import { useForceHost } from './host';
import {
	debouncePublish, openDiagSync, type DiagSyncChannel, type DiagSyncMsg,
} from './diagSync';

const props = withDefaults(defineProps<{
	diagPath: string;
	analysisId: string;
	diagMetrics: Record<string, unknown> | null;
	initialRecipe?: Recipe | null;
	bakedRecipe?: Recipe | null;
	/** true while the host is running a bake for this cut (owned by the page). */
	baking?: boolean;
	/** progress/failure text for the running bake, shown in the state strip. */
	bakeMessage?: string | null;
}>(), { initialRecipe: null, bakedRecipe: null, baking: false, bakeMessage: null });

const emit = defineEmits<{
	(e: 'bake', recipe: Recipe): void;
	(e: 'popout', payload: { type: string; channel?: string }): void;
}>();

// JSON clone, NOT structuredClone: `initialRecipe` arrives from the page's reactive row list,
// so it is a Vue Proxy, and structuredClone throws DataCloneError on a Proxy. That killed
// setup() outright — every cut with a saved diag_recipe rendered an empty workbench.
const recipe = ref<Recipe>(JSON.parse(JSON.stringify(props.initialRecipe ?? DEFAULT_RECIPE)));
const bakedWS = ref<WorkingSet | null>(null);
const previewWS = ref<WorkingSet | null>(null);
const loadError = ref<string | null>(null);
const previewing = ref(false);
const previewMs = ref<number | null>(null);
const previewErr = ref<string | null>(null);
const selection = ref<Selection>(null);
const skippedOps = ref<string[]>([]);
const recipeCollapsed = ref(false);

// --- click a step in the Pipeline panel to revert the hero view to its state --------------
const revertStepId = ref<string | null>(null);
// Index, not just id: recomputed from the CURRENT recipe every time, so a drag-reorder in the
// Pipeline panel (which keeps the id but moves the position) never sends a stale stop_after.
const revertIndex = computed(() => {
	if (!revertStepId.value) return null;
	const idx = recipe.value.steps.findIndex((s) => s.id === revertStepId.value);
	if (idx === -1) return null;
	// Defense in depth: RecipePanel already refuses to emit revert-step for a base-tier step
	// (stepIsRevertable), but this is the value that actually reaches the network request, so
	// it independently guards the same invariant rather than trusting the emitter.
	if (idx < firstDerivedIndex(recipe.value)) return null;
	return idx;
});
// The reverted step was removed from the recipe entirely (not just moved) -- fall back to the
// full pipeline rather than silently pinning a stop_after that no longer names anything.
watch(() => recipe.value.steps, (steps) => {
	if (revertStepId.value && !steps.some((s) => s.id === revertStepId.value)) revertStepId.value = null;
}, { deep: true });

// SpatialPanel only has a rendering path for resid_z (the octree's baked base colour) and the
// four spatial ops it can live-recompute on the framed view (its own OP_OF map). Every other
// produced channel is selectable in its dropdown but has no visual effect yet -- the
// multi-column /viewport response those channels would need (grid_fill + grid_support,
// inverted, ...) has no consuming UI (deferred when /viewport was widened, Phase H slice 2.5).
// Switching to one of those here would silently change nothing on screen, so only auto-switch
// when the target channel is one the hero view can actually show; the truncated preview
// itself still reaches the Signal chart and Selection Inspector regardless.
const RENDERABLE_CHANNELS = new Set(['residZ', 'giStar', 'clusterId', 'segmentId', 'gmmId']);

// "The hero view": the spatial panel visually on top (smallest y, then x) rather than the one
// that happens to be first in the layout ARRAY -- a drag-reorder changes the former, not the
// latter, and "run/revert on this view" should follow what the analyst sees on top.
const heroSpatial = computed(() =>
	layout.value
		.filter((p) => p.type === 'spatial')
		.slice()
		.sort((a, b) => a.y - b.y || a.x - b.x)[0] ?? null);

function onRevertStep(stepId: string | null) {
	revertStepId.value = stepId;
	if (!stepId) return;
	const step = recipe.value.steps.find((s) => s.id === stepId);
	const channel = step ? primaryChannelForOp(step.op) : null;
	if (!channel || !RENDERABLE_CHANNELS.has(channel)) return;
	if (heroSpatial.value) setChannel(heroSpatial.value.i, channel);
}

// Steps whose inputs no earlier enabled step produces. The service refuses these with a 422
// carrying a Python error string; catching it here marks the step and skips the doomed request.
const problems = computed(() => recipeProblems(recipe.value));
const recipeValid = computed(() => problems.value.length === 0);

// --- paint layers ---------------------------------------------------------------------------
const layers = ref<DiagLayer[]>([]);
const activeLayerName = ref<string | null>(null);
const drawing = ref(false);
async function loadLayers() {
	try { layers.value = await fetchLayers(props.analysisId); }
	catch { layers.value = []; }
}
onMounted(loadLayers);
watch(() => props.analysisId, () => { activeLayerName.value = null; drawing.value = false; loadLayers(); });

const seedLayerNames = computed(() => layers.value.filter((l) => l.role === 'seed').map((l) => l.name));

// --- recipe library ------------------------------------------------------------------------
const library = ref<SavedRecipe[]>([]);
async function loadLibrary() {
	try { library.value = await fetchRecipeLibrary(); }
	catch { library.value = []; }
}
onMounted(loadLibrary);
function onApplyRecipe(r: Recipe) { recipe.value = r; }

const segmentLegend = computed(() => {
	const seg = recipe.value.steps.find((s) => s.op === 'grow_segmentation' && s.on);
	const names = (seg?.inputs?.seeds as { layers?: string[] } | undefined)?.layers ?? [];
	return names.map((name, id) => ({ id, name }));
});

const boundMasks = computed(() =>
	layers.value.filter((l) => l.role === 'mask' && (l.geometry?.polygons?.length ?? 0) > 0));
const activeMask = computed(() =>
	boundMasks.value.find((l) => l.name === activeLayerName.value) ?? boundMasks.value[0] ?? null);

const activeWS = computed(() => previewWS.value ?? bakedWS.value);
const bakeStale = computed(() =>
	!recipesEquivalent(recipe.value, props.bakedRecipe ?? DEFAULT_RECIPE));
const channelOptions = computed(() => recipeChannels(recipe.value));

async function loadBaked() {
	loadError.value = null;
	bakedWS.value = null;
	try {
		const base = `${useForceHost().octreeUrl}/diag/${props.diagPath}/`;
		bakedWS.value = workingSetFromD1an(await fetchD1an(`${base}attrs.d1an`));
	} catch (e: any) {
		loadError.value = e?.message || 'failed to load analysis attributes';
	}
}
onMounted(loadBaked);
watch(() => props.diagPath, () => { previewWS.value = null; loadBaked(); });

// Debounced preview: any recipe edit fires POST /diag/preview after 400 ms of quiet.
// revertStepId is in the dependency list too -- clicking a step card to view its state (or
// clicking it again to return to the full pipeline) needs the same request, just truncated.
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewAbort: AbortController | null = null;
watch([recipe, () => layers.value, activeLayerName, revertStepId], () => {
	if (previewTimer) clearTimeout(previewTimer);
	previewTimer = setTimeout(runPreview, 400);
}, { deep: true });

function recipeWithMask(): Recipe {
	if (!activeMask.value) return recipe.value;
	const r = JSON.parse(JSON.stringify(recipe.value)) as Recipe;
	for (const s of r.steps) {
		if (s.op === 'radial_detrend') {
			(s as { inputs?: unknown }).inputs = { mask: { layer: activeMask.value.name, required: false } };
		}
	}
	return r;
}

function onBake() {
	const baked = recipeWithMask();
	recipe.value = JSON.parse(JSON.stringify(baked));
	emit('bake', baked);
}

const recipeHasBoundSeeds = computed(() => recipe.value.steps.some((s) =>
	s.on && s.op === 'grow_segmentation'
	&& (((s.inputs?.seeds as { layers?: string[] } | undefined)?.layers?.length ?? 0) > 0)));

async function runPreview() {
	previewAbort?.abort();
	if (!recipeValid.value) {
		previewing.value = false; previewErr.value = null; previewMs.value = null;
		return;
	}
	if (!bakeStale.value && !activeMask.value && !recipeHasBoundSeeds.value && revertIndex.value === null) {
		previewWS.value = null; previewErr.value = null; previewMs.value = null;
		return;
	}
	const ac = new AbortController();
	previewAbort = ac;
	previewing.value = true;
	previewErr.value = null;
	try {
		const r = await fetchDiagPreview(
			props.analysisId, recipeWithMask(), null, ac.signal,
			layers.value.length ? layersForRequestSafe() : undefined,
			revertIndex.value,
		);
		if (ac.signal.aborted) return;
		previewWS.value = workingSetFromD1an(r.attrs);
		previewMs.value = r.ms;
		skippedOps.value = r.skipped;
	} catch (e: any) {
		if (ac.signal.aborted || e?.name === 'AbortError') return;
		previewErr.value = e?.message || 'preview failed';
	} finally {
		if (previewAbort === ac) previewing.value = false;
	}
}
function layersForRequestSafe() { return layersForRequest(layers.value); }

// --- spatial panels: aggregate their independent viewport state ---------------------------
// Each SpatialPanel owns its own channel + recompute; the workbench only needs the union for
// the state strip ("something is recomputing") and one result for the cluster table.
const panelResults = reactive<Record<string, ViewportResult | null>>({});
const panelBusy = reactive<Record<string, boolean>>({});
const spatialRefs = new Map<string, { runViewport: (op: ViewportOp, o?: { focus: boolean }) => void }>();
function bindSpatial(id: string, el: unknown) {
	if (el) spatialRefs.set(id, el as { runViewport: (op: ViewportOp, o?: { focus: boolean }) => void });
	else { spatialRefs.delete(id); delete panelResults[id]; delete panelBusy[id]; }
}
const anyViewportBusy = computed(() => Object.values(panelBusy).some(Boolean));
// The cluster table describes whichever spatial view is currently showing an HDBSCAN result,
// so the table and that map cannot disagree. Falls back to the bake when none is.
const hdbscanResult = computed<ViewportResult | null>(() =>
	Object.values(panelResults).find((r) => r?.op === 'hdbscan') ?? null);

// "Run <op> on this view" from the Pipeline panel routes to the hero spatial view (the one
// visually on top -- see heroSpatial), not whichever is first in the layout array.
function runStepOnView(op: ViewportOp) {
	const hero = heroSpatial.value;
	if (hero) spatialRefs.get(hero.i)?.runViewport(op, { focus: true });
}

function onClusterSelect(id: number | null) {
	selection.value = id == null ? null : { kind: 'cluster', id };
}

function _upsert(saved: DiagLayer) {
	const i = layers.value.findIndex((l) => l.layer_id === saved.layer_id);
	layers.value = i >= 0
		? layers.value.map((l) => (l.layer_id === saved.layer_id ? saved : l))
		: [...layers.value, saved];
}
async function onAddLayer(role: LayerRole): Promise<DiagLayer> {
	const name = `${role}-${Date.now().toString(36).slice(-4)}`;
	const saved = await saveLayer({ analysis_id: props.analysisId, name, role, geometry: { polygons: [] } });
	_upsert(saved);
	activeLayerName.value = saved.name;
	drawing.value = true;
	return saved;
}
async function onPolygon(ring: [number, number][]) {
	let target = layers.value.find((l) => l.name === activeLayerName.value);
	if (!target) target = await onAddLayer('mask');
	const geometry = { polygons: [...(target.geometry?.polygons ?? []), ring] };
	_upsert(await saveLayer({ ...target, geometry }));
}
async function onRenameLayer({ layer, name }: { layer: DiagLayer; name: string }) {
	const wasActive = activeLayerName.value === layer.name;
	const saved = await saveLayer({ ...layer, name });
	_upsert(saved);
	if (wasActive) activeLayerName.value = saved.name;
}
async function onDeleteLayer(layer: DiagLayer) {
	await deleteLayer(layer.layer_id);
	layers.value = layers.value.filter((l) => l.layer_id !== layer.layer_id);
	if (activeLayerName.value === layer.name) activeLayerName.value = null;
}

const stats = computed(() => (activeWS.value ? computeStats(activeWS.value, selection.value) : null));

function clustersFromViewport(r: ViewportResult): ClusterRow[] {
	// r.value is absent for a multi-`outputs` result (see diagViewport.ts); this table only
	// reads the legacy single column, which is all any current caller ever requests here.
	if (!r.value) return [];
	const value = r.value;
	const acc = new Map<number, { n: number; rMin: number; rMax: number }>();
	for (let i = 0; i < r.n; i++) {
		const id = value[i];
		if (!Number.isFinite(id)) continue;
		const key = id < 0 ? -1 : id;
		const rad = Math.hypot(r.x[i], r.y[i]);
		const a = acc.get(key);
		if (a) { a.n++; if (rad < a.rMin) a.rMin = rad; if (rad > a.rMax) a.rMax = rad; }
		else acc.set(key, { n: 1, rMin: rad, rMax: rad });
	}
	const total = r.n || 1;
	return [...acc.entries()]
		.map(([id, a]) => ({ id, n: a.n, fraction: a.n / total, meanAbsResidZ: null, maxGiStar: null, rMin: a.rMin, rMax: a.rMax }))
		.sort((a, b) => (a.id < 0 ? 1 : b.id < 0 ? -1 : b.n - a.n));
}
const clusters = computed<ClusterRow[]>(() => {
	const r = hdbscanResult.value;
	if (r) return clustersFromViewport(r);
	return activeWS.value ? clusterStats(activeWS.value) : [];
});
const clusterCaption = computed(() => {
	const r = hdbscanResult.value;
	if (r) return `${r.n.toLocaleString()} points in the framed view · full resolution`;
	const n = activeWS.value?.n ?? 0;
	return `${n.toLocaleString()} points · whole cut at analysis resolution`;
});
const clustersLive = computed(() => !!hdbscanResult.value
	|| layout.value.some((p) => p.type === 'spatial' && p.channel === 'clusterId')
	|| (activeWS.value ? clusterStats(activeWS.value).length > 0 : false));

// --- panel layout: add / close / reset / persist (RecordPage's model) ---------------------
const layout = ref<DiagPanelInst[]>(loadDiagLayout());
watch(layout, (l) => saveDiagLayout(l), { deep: true });
const addOpen = ref(false);
const addable = computed(() => Object.entries(DIAG_PANEL_TYPES).map(([type, m]) => ({
	type, ...m, disabled: !!m.single && layout.value.some((p) => p.type === type),
})));
function addPanel(type: string) {
	addOpen.value = false;
	const inst = newPanelInst(type, layout.value);
	if (inst) layout.value = [...layout.value, inst];
}
function closePanel(id: string) {
	layout.value = layout.value.filter((p) => p.i !== id);
}
function resetLayout() {
	try { localStorage.removeItem(DIAG_LAYOUT_LS_KEY); } catch { /* private mode */ }
	layout.value = loadDiagLayout();   // now returns the built-in default
}
function panelTitle(p: DiagPanelInst): string {
	if (p.type === 'spatial') {
		const opt = channelOptions.value.find((o) => o.key === p.channel);
		if (!opt) return 'Spatial view';
		// ALL_CHANNELS' label is "col_name — meaning", deliberately technical for the channel
		// SELECT dropdown; the compact panel title should lead with the MEANING instead --
		// "Anomaly z-score (resid_z)", not the bare column name "resid_z" (Phase H slice 3).
		const [col, meaning] = opt.label.split(' — ');
		if (!meaning) return `Spatial · ${col}`;
		return `Spatial · ${meaning.charAt(0).toUpperCase()}${meaning.slice(1)} (${col})`;
	}
	return DIAG_PANEL_TYPES[p.type].title;
}
function setChannel(id: string, c: string) {
	const p = layout.value.find((x) => x.i === id);
	if (p) p.channel = c;
}
function onPopout(channel: string) {
	emit('popout', { type: 'spatial', channel });
}

// ---- Responsive grid height (ported from RecordPage) -------------------------------------
const GRID_MARGIN = 12;
const MIN_ROW_H = 18;
const BOTTOM_PAD = 2;
const gridEl = ref<HTMLElement | null>(null);
const availableHeight = ref(700);
function measureGrid() {
	if (!gridEl.value) return;
	const top = gridEl.value.getBoundingClientRect().top + window.scrollY;
	availableHeight.value = Math.max(320, Math.floor(window.innerHeight - top - BOTTOM_PAD));
}
const bottomRow = computed(() => layout.value.reduce((m, p) => Math.max(m, p.y + p.h), 0) || 1);
const rowHeight = computed(() =>
	Math.max(MIN_ROW_H, Math.floor((availableHeight.value - GRID_MARGIN) / bottomRow.value) - GRID_MARGIN));

const NARROW_BREAKPOINT = 640;
const narrow = ref(false);
function checkNarrow() { narrow.value = window.innerWidth < NARROW_BREAKPOINT; }
const stackedLayout = computed(() => {
	let y = 0;
	return layout.value.map((p) => { const out = { ...p, x: 0, w: 1, y }; y += p.h; return out; });
});
const displayLayout = computed({
	get: () => (narrow.value ? stackedLayout.value : layout.value),
	set: (v: DiagPanelInst[]) => {
		if (narrow.value) return;
		// grid-layout-plus rewrites x/y/w/h; keep our own `channel` field, which it drops.
		layout.value = v.map((p) => {
			const prev = layout.value.find((q) => q.i === p.i);
			return prev ? { ...p, channel: prev.channel } : p;
		});
	},
});

let gridRO: ResizeObserver | undefined;
onMounted(() => {
	gridRO = new ResizeObserver(measureGrid);
	if (gridEl.value) gridRO.observe(gridEl.value);
	measureGrid();
	checkNarrow();
	window.addEventListener('resize', measureGrid);
	window.addEventListener('resize', checkNarrow);
	document.addEventListener('click', () => { addOpen.value = false; });
});

const multiMaskNote = computed(() =>
	boundMasks.value.length > 1 ? ' · only the selected mask is applied' : '');

type StateKind = 'error' | 'busy' | 'preview' | 'stale' | 'baked';
const state = computed<{ kind: StateKind; text: string }>(() => {
	if (problems.value.length) {
		return { kind: 'error', text: `${problems.value.length} step${problems.value.length > 1 ? 's' : ''} cannot run — see the Pipeline panel` };
	}
	if (props.baking) {
		return { kind: 'busy', text: props.bakeMessage || 'Baking on the host — this rewrites the authoritative result…' };
	}
	if (props.bakeMessage) return { kind: 'error', text: props.bakeMessage };
	if (anyViewportBusy.value) return { kind: 'busy', text: 'Recomputing on the framed view at full resolution…' };
	if (previewing.value) return { kind: 'preview', text: `Updating the live preview — approximate; Bake for exact numbers${multiMaskNote.value}` };
	if (previewWS.value) return { kind: 'preview', text: `Live preview · ${previewMs.value ?? '?'} ms · approximate — Bake to make it authoritative${multiMaskNote.value}` };
	if (bakeStale.value) return { kind: 'stale', text: 'Showing the last bake — the recipe has been edited since. Bake to apply it.' };
	if (activeMask.value) return { kind: 'preview', text: `Mask applied in preview only — Bake to persist it${multiMaskNote.value}` };
	return { kind: 'baked', text: 'Showing the baked result for this cut — authoritative.' };
});

// --- pop-out synchronisation ------------------------------------------------------------
//
// This window is the sole WRITER: detached Spatial views (DiagPanelWindow) apply what they
// receive and never publish back, so there is no edit loop and no "who wins" question. A
// pop-out opened after the last edit would otherwise show pre-edit state, so it announces
// itself with `hello` and we answer with everything it needs.
let sync: DiagSyncChannel | null = null;

function syncState(): DiagSyncMsg[] {
	return [
		{ t: 'recipe', recipe: JSON.parse(JSON.stringify(recipe.value)) },
		{ t: 'layers', layers: JSON.parse(JSON.stringify(layers.value)) },
		{
			t: 'isolate',
			clusterId: selection.value?.kind === 'cluster' ? selection.value.id : null,
		},
	];
}

// The recipe publishes on every keystroke; coalesce so a pop-out re-renders at a rate it can
// actually draw. `hello` bypasses this via flush(). syncState() (two full deep clones of the
// recipe + layers) runs INSIDE the debounced callback, not at every push -- a 20-vertex
// polygon drag fired 20 clones a second, all but the last discarded, before this.
const publishState = debouncePublish<void>(() => {
	for (const m of syncState()) sync?.post(m);
}, 150);

onMounted(() => {
	sync = openDiagSync(props.analysisId, (msg) => {
		if (msg.t === 'hello') { publishState.push(); publishState.flush(); }
	});
});

watch(
	[recipe, layers, selection],
	() => publishState.push(),
	{ deep: true },
);

// A different cut means a different channel; re-open before announcing anything on it.
watch(() => props.analysisId, (id) => {
	publishState.cancel();
	sync?.close();
	sync = openDiagSync(id, (msg) => {
		if (msg.t === 'hello') { publishState.push(); publishState.flush(); }
	});
});

onBeforeUnmount(() => {
	previewAbort?.abort();
	if (previewTimer) clearTimeout(previewTimer);
	gridRO?.disconnect();
	window.removeEventListener('resize', measureGrid);
	window.removeEventListener('resize', checkNarrow);
	publishState.cancel();
	sync?.close();
	sync = null;
});
</script>

<template>
	<div class="diag-workbench">
		<div v-if="loadError" class="dw-error">{{ loadError }}</div>
		<div ref="gridEl" class="dw-gridwrap">
			<div class="dw-panel-controls">
				<div class="dw-addwrap">
					<button class="dw-ctl" title="Add a panel" @click.stop="addOpen = !addOpen">
						<span class="material-symbols-rounded">add</span>
					</button>
					<div v-if="addOpen" class="dw-addmenu" @click.stop>
						<button v-for="a in addable" :key="a.type" :disabled="a.disabled" @click="addPanel(a.type)">
							<span class="material-symbols-rounded">{{ a.icon }}</span>{{ a.title }}
							<span v-if="a.disabled" class="dw-added">added</span>
						</button>
					</div>
				</div>
				<button class="dw-ctl" title="Reset panel layout" @click="resetLayout">
					<span class="material-symbols-rounded">grid_view</span>
				</button>
			</div>

			<GridLayout
				v-model:layout="displayLayout" :col-num="narrow ? 1 : 12" :row-height="rowHeight"
				:margin="[12, 12]" :is-draggable="!narrow" :is-resizable="!narrow"
				:use-css-transforms="true" :vertical-compact="true"
			>
				<GridItem
					v-for="item in displayLayout" :key="item.i"
					:x="item.x" :y="item.y" :w="item.w" :h="item.h" :i="item.i"
					drag-allow-from=".wb-panel-handle" :min-w="narrow ? 1 : 2" :min-h="3"
				>
					<WorkbenchPanel
						:title="panelTitle(item)" :icon="DIAG_PANEL_TYPES[item.type].icon"
						:closable="!(DIAG_PANEL_TYPES[item.type].single && ['recipe', 'signal'].includes(item.type))"
						@close="closePanel(item.i)"
					>
						<template v-if="item.type === 'spatial' && item.channel && CHANNEL_HELP[item.channel]" #title-extra>
							<InfoTip :text="CHANNEL_HELP[item.channel]" placement="left" />
						</template>

						<!-- Pipeline -->
						<RecipePanel
							v-if="item.type === 'recipe'"
							v-model:recipe="recipe"
							v-model:collapsed="recipeCollapsed"
							:baked="!!bakedWS" :bake-stale="bakeStale"
							:previewing="previewing" :preview-ms="previewMs" :preview-error="previewErr"
							:seed-layer-names="seedLayerNames" :library="library"
							:problems="problems" :baking="baking" :skipped-ops="skippedOps"
							:busy-op="anyViewportBusy ? 'any' : null"
							:revert-step-id="revertStepId"
							@bake="onBake" @apply="onApplyRecipe" @library-changed="loadLibrary"
							@run-step="runStepOnView" @revert-step="onRevertStep"
						/>

						<!-- Spatial view (multi) -->
						<SpatialPanel
							v-else-if="item.type === 'spatial'"
							:ref="(el) => bindSpatial(item.i, el)"
							:analysis-id="analysisId"
							:octree-path="`${diagPath}/full`"
							:recipe="recipe" :recipe-valid="recipeValid"
							:channel-options="channelOptions"
							:layers="layers" :active-layer-name="activeLayerName"
							:selection="selection" :drawing="drawing"
							:initial-channel="item.channel"
							@polygon="onPolygon"
							@update:channel="(c) => setChannel(item.i, c)"
							@result="(r) => panelResults[item.i] = r"
							@busy="(b) => panelBusy[item.i] = b"
							@popout="onPopout"
						/>

						<!-- Signal -->
						<SignalPanel
							v-else-if="item.type === 'signal'"
							v-model:recipe="recipe"
							:analysis-id="analysisId" :layers="layers" :recipe-valid="recipeValid"
							:active-working-set="activeWS" :selection="selection"
							@update:selection="(s) => (selection = s)"
						/>

						<!-- Clusters -->
						<template v-else-if="item.type === 'clusters'">
							<ClusterTable
								v-if="clustersLive"
								:rows="clusters" :caption="clusterCaption"
								:active-id="selection?.kind === 'cluster' ? selection.id : null"
								@select="onClusterSelect"
							/>
							<div v-else class="dw-loading">
								Colour a Spatial view by <code>cluster_id</code> to populate this.
							</div>
							<div v-if="segmentLegend.length" class="dw-seg-legend">
								<span v-for="c in segmentLegend" :key="c.id" class="dw-seg-row">
									<span class="dw-seg-swatch" :style="{ background: clusterColorCss(c.id) }" />
									{{ c.id }} · {{ c.name }}
								</span>
							</div>
						</template>

						<!-- Selection inspector -->
						<template v-else-if="item.type === 'inspector'">
							<SelectionInspector v-if="stats" :stats="stats" />
							<div v-else class="dw-loading">brush the Signal chart or pick a cluster</div>
						</template>

						<!-- Painted layers live in the Pipeline panel's footer -->
						<template v-if="item.type === 'recipe'" #footer>
							<div class="dw-layers-row">
								<LayerPanel
									:layers="layers"
									v-model:active-name="activeLayerName"
									v-model:drawing="drawing"
									@add="onAddLayer" @rename="onRenameLayer" @delete="onDeleteLayer"
								/>
								<InfoTip :text="PANEL_HELP.layers" placement="left" />
							</div>
						</template>
					</WorkbenchPanel>
				</GridItem>
			</GridLayout>
		</div>

		<div class="dw-state" :class="state.kind">
			<span class="dw-state-dot" />
			{{ state.text }}
		</div>
		<BandwidthStrip :metrics="props.diagMetrics as any" />
	</div>
</template>

<style scoped>
.diag-workbench { display: flex; flex-direction: column; min-height: 0; }
.dw-gridwrap { position: relative; margin: 8px 10px 0; }
.dw-gridwrap :deep(.vgl-layout) { margin: 0; }
.dw-gridwrap :deep(.vgl-item--placeholder) { background: color-mix(in srgb, var(--accent, #38bdf8) 18%, transparent); border-radius: 12px; }
.dw-gridwrap :deep(.vgl-item__resizer) { z-index: 5; }
.dw-error { padding: 8px 12px; color: var(--danger, #fca5a5); font-size: var(--fs-sm, 12px); }
.dw-loading { display: flex; align-items: center; justify-content: center; height: 100%; padding: 12px; text-align: center; color: var(--text-dim); font-size: var(--fs-sm, 12px); }
.dw-loading code { font-size: var(--fs-xs, 11px); background: var(--bg-2, #111a33); padding: 1px 4px; border-radius: 4px; }

.dw-panel-controls { position: fixed; right: 20px; bottom: 56px; z-index: 25; display: flex; align-items: center; gap: 8px; }
.dw-addwrap { position: relative; }
.dw-ctl { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; background: var(--bg-1, #0f172a); border: 1px solid var(--border, rgba(255,255,255,0.16)); color: var(--text-dim, #94a3b8); cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.4); }
.dw-ctl:hover { color: var(--accent, #38bdf8); }
.dw-ctl .material-symbols-rounded { font-size: var(--icon-md, 18px); }
.dw-addmenu { position: absolute; right: 0; bottom: calc(100% + 8px); min-width: 210px; background: var(--bg-1, #0f172a); border: 1px solid var(--border, rgba(255,255,255,0.16)); border-radius: 10px; box-shadow: 0 10px 28px rgba(0,0,0,0.5); overflow: hidden; }
.dw-addmenu button { display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: var(--fs-sm, 12px); padding: 8px 11px; background: none; border: none; color: var(--text, #e5e7eb); cursor: pointer; text-align: left; }
.dw-addmenu button:hover:not(:disabled) { background: rgba(255,255,255,0.05); }
.dw-addmenu button:disabled { color: var(--text-dim, #94a3b8); cursor: default; }
.dw-addmenu .material-symbols-rounded { font-size: var(--icon-sm, 16px); color: var(--text-dim, #94a3b8); }
.dw-added { margin-left: auto; font-size: var(--fs-xs, 11px); text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-dim, #94a3b8); }

.dw-seg-legend { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding: 0 8px 6px; font-size: var(--fs-xs, 11px); color: var(--text-dim, #94a3b8); }
.dw-seg-row { display: inline-flex; align-items: center; gap: 4px; }
.dw-seg-swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.dw-layers-row { display: flex; align-items: flex-start; gap: 6px; }
.dw-layers-row > :first-child { flex: 1; min-width: 0; }

.dw-state { display: flex; align-items: center; gap: 7px; padding: 5px 12px; font-size: var(--fs-xs, 11px); color: var(--text-dim, #94a3b8); border-top: 1px solid var(--border, rgba(255,255,255,0.1)); }
.dw-state-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dw-state.preview { color: #fcd34d; background: color-mix(in srgb, #d97706 12%, transparent); }
.dw-state.busy { color: #7dd3fc; background: color-mix(in srgb, #38bdf8 12%, transparent); }
.dw-state.stale { color: #fca5a5; }
.dw-state.error { color: #fca5a5; background: color-mix(in srgb, #dc2626 14%, transparent); }
.dw-state.baked { color: #86efac; }
</style>
