<script setup lang="ts">
/*
 * The FAST analysis page (DESIGN.md section 5b): three columns that fill the screen height,
 * Samples -> Runs | the run (identity, peaks, statistics tabs) | the plots. This component loads the data
 * and keeps the shared state (selection, zoom, hover); the columns are FastLists, FastRunColumn and FastPlots.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import './fast.css';
import FastLists from './FastLists.vue';
import FastPlots from './FastPlots.vue';
import FastRunColumn from './FastRunColumn.vue';
import { useFastHost } from './host';
import type { SeriesMeta, Trace } from './fastCache';
import { type ListRun, sampleKeyOf } from './fastSamples';
import { type Tile, seedTiles, validTiles } from './fastTiles';
import { windowZoom } from './runBands';
import { fastProfile } from './profiles/fastProfile';
import type { RunProfile, RunTab, RunWindowBand } from './profile';

// The profile carries everything specific to one kind of run (FAST by default): the list query, the run loader,
// the figures, the wording and the layout key. See profile.ts.
const props = withDefaults(defineProps<{ profile?: RunProfile }>(), { profile: () => fastProfile });
const profile = props.profile;
const host = useFastHost();
const api = host.api;
const route = useRoute();

// ---------------------------------------------------------------- state
const loading = ref(true);
const rows = ref<ListRun[]>([]);
const sample = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const detail = ref<any | null>(null);
const loadingDetail = ref(false);
const tab = ref<RunTab>('stats');
const tiles = ref<Tile[]>([]);
const zoomTool = ref(false);

// ---------------------------------------------------------------- layout, remembered per device
const LAYOUT_KEY = profile.layoutKey;
// True until the first trace seeds the default tiles; a saved non-empty layout suppresses that so we never
// clobber the user's arrangement.
let freshTiles = true;
let pendingSelect: string | null = null;
try {
	const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
	const saved = validTiles(v.tiles);
	if (saved.length) { tiles.value = saved; freshTiles = false; }
	if (typeof v.selectedId === 'string') pendingSelect = v.selectedId;
	if (profile.tabs.includes(v.tab)) tab.value = v.tab;
} catch { /* nothing saved, or storage is blocked */ }
watch([tiles, selectedId, tab], () => {
	try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tiles: tiles.value, selectedId: selectedId.value, tab: tab.value })); } catch { /* storage is blocked */ }
}, { deep: true });

const layoutEl = ref<HTMLElement | null>(null);
const availableHeight = ref(700);
const layoutW = ref(1400);
// The page reacts to its own width, not the viewport's (the host reserves side chrome): from 1500px the
// lists are columns, below that they fold into a tab, and under 900px everything stacks and the page scrolls.
const stacked = computed(() => layoutW.value < 900);
const folded = computed(() => !stacked.value && layoutW.value < 1500);
const gridCols = computed(() => (stacked.value ? 'minmax(0, 1fr)' : folded.value ? '44px 300px minmax(0, 1fr)' : '256px 330px minmax(0, 1fr)'));
function measure() {
	if (!layoutEl.value) return;
	const r = layoutEl.value.getBoundingClientRect();
	layoutW.value = r.width;
	availableHeight.value = Math.max(460, Math.floor(window.innerHeight - r.top - 12));
}
let ro: ResizeObserver | undefined;
onMounted(() => { ro = new ResizeObserver(measure); if (layoutEl.value) ro.observe(layoutEl.value); measure(); window.addEventListener('resize', measure); });
onBeforeUnmount(() => {
	ro?.disconnect(); window.removeEventListener('resize', measure);
	clearInterval(clockTimer);
	opGen++; listGen++;   // an in-flight load must not write to a page that is gone
});

// ---------------------------------------------------------------- data load
const listError = ref<string | null>(null);
let listGen = 0;
const errMsg = (e: any, fallback: string): string => e?.response?.data?.errors?.[0]?.message || e?.message || fallback;

// Newest run first. operation_date is the real chronology; the pass_code starts with the day of month, so
// sorting by the code would scramble the order across months.
const byDateDesc = (a: ListRun, b: ListRun) => (b.operation_date ? Date.parse(b.operation_date) : 0) - (a.operation_date ? Date.parse(a.operation_date) : 0);

onMounted(async () => {
	const gen = ++listGen;
	try {
		const res = await api.get('/items/manufacturing_operations', {
			params: {
				filter: { process_category: { _eq: profile.listQuery.category } },
				fields: profile.listQuery.fields,
				sort: ['-operation_date'], limit: -1,
			},
		});
		// Sorted once here and the quality worded once per row: with 10k+ runs, redoing either per keystroke
		// or selection is what makes the list feel heavy.
		const mapped: ListRun[] = (res.data?.data ?? []).map((o: any) => ({ ...o, id: o.operation_id, quality: profile.quality(o) }));
		mapped.sort(byDateDesc);
		if (gen !== listGen) return;   // unmounted while loading
		rows.value = mapped;
	} catch (e: any) {
		if (gen !== listGen) return;
		listError.value = `Could not load the ${profile.key === 'fast' ? 'FAST' : profile.title.replace(/ plotter$/, '')} operations: ${errMsg(e, 'request failed')}`;
	} finally {
		if (gen === listGen) {
			loading.value = false;
			await nextTick(); measure();
			const want = (route.query.operation as string) || pendingSelect;
			const m = want ? rows.value.find((o) => o.id === want) : undefined;
			if (m) { sample.value = sampleKeyOf(m); selectOp(m); }
		}
	}
});

// ---------------------------------------------------------------- select + trace
const trace = ref<Trace | null>(null);
const runData = ref<any | null>(null);   // the run's own record: what profile.loadRun returned
const traceLoading = ref(false);
const runError = ref<string | null>(null);

// Every selection (and unmount) bumps opGen; a load that finishes after that is stale and must not write to
// detail/runData/trace, which now belong to the newer selection.
let opGen = 0;

async function selectOp(row: ListRun) {
	const gen = ++opGen;
	selectedId.value = row.id;
	loadingDetail.value = true; detail.value = null; trace.value = null; runData.value = null; runError.value = null; traceLoading.value = false; bands.value = []; reloading.value = false;
	try {
		const res = await api.get(`/items/manufacturing_operations/${row.id}`, { params: { fields: profile.detailFields } });
		if (gen !== opGen) return;
		detail.value = res.data.data;
		await loadRunData(row.id, gen);
		if (gen === opGen) openOnWindow();
	} catch (e: any) {
		if (gen === opGen) runError.value = `Could not load this operation: ${errMsg(e, 'request failed')}`;
	} finally { if (gen === opGen) loadingDetail.value = false; }
}

async function loadRunData(operationId: string, gen: number) {
	const loaded = await profile.loadRun(api, operationId);
	if (gen !== opGen) return;
	runData.value = loaded;
	await Promise.all([loadTraceData(gen), loadBands(gen)]);
}

async function loadTraceData(gen: number) {
	const run = runData.value;
	traceLoading.value = true;
	try {
		const loaded = await profile.loadTrace(api, run);
		if (gen !== opGen) return;
		if (!loaded) return;
		trace.value = loaded;
		if (freshTiles) {
			const seeded = seedTiles(catalog.value, 1, { groups: profile.seedGroups, series: profile.seedSeries, strict: profile.seedStrict });
			if (seeded.length) { tiles.value = seeded; freshTiles = false; }
		}
	} catch (e: any) { console.error('FAST trace load failed', e); if (gen === opGen) runError.value = 'Could not load the trace for this run.'; }
	finally { if (gen === opGen) traceLoading.value = false; }
}

// ---------------------------------------------------------------- run windows (profiles that have them; FAST has none)
const bands = ref<RunWindowBand[]>([]);
const startMs = computed(() => profile.startMs?.(runData.value) ?? null);
async function loadBands(gen: number) {
	if (!profile.windows) return;
	try {
		const loaded = await profile.windows(api, runData.value);
		if (gen === opGen) bands.value = loaded;
	} catch (e: any) { console.warn('Run windows could not be loaded', e); }   // the plots work without the bands
}
// The plots open on the run's own window, with a little context either side.
function openOnWindow() {
	const t = trace.value, cur = bands.value.find((b) => b.current);
	if (!t || t.n < 2 || !cur) return;
	const z = windowZoom(cur, t.time[0], t.time[t.n - 1]);
	if (z && (z.start > t.time[0] || z.end < t.time[t.n - 1])) onZoom(z);   // a window that is the whole log needs no zoom
}

// After an upload, a linked log or a new window: read the run again, in place (the column and its messages stay).
const reloading = ref(false);
async function reloadRun({ resetView }: { resetView: boolean }) {
	const id = selectedId.value;
	if (!id) return;
	const gen = ++opGen;
	reloading.value = true;
	try {
		const res = await api.get(`/items/manufacturing_operations/${id}`, { params: { fields: profile.detailFields } });
		if (gen !== opGen) return;
		detail.value = res.data.data;
		const loaded = await profile.loadRun(api, id);
		if (gen !== opGen) return;
		runData.value = loaded;
		if (resetView) onZoom(null);
		await Promise.all([loadTraceData(gen), loadBands(gen)]);
		if (gen !== opGen) return;
		const q = profile.runQuality?.(loaded);
		if (q) rows.value = rows.value.map((r) => (r.id === id ? { ...r, quality: q } : r));
		if (resetView) openOnWindow();
	} catch (e: any) {
		if (gen === opGen) runError.value = `Could not reload this run: ${errMsg(e, 'request failed')}`;
	} finally { if (gen === opGen) reloading.value = false; }
}


const catalog = computed<SeriesMeta[]>(() => profile.seriesOf(runData.value));
const selectedRow = computed(() => rows.value.find((r) => r.id === selectedId.value) ?? null);

// what the plot area says while there is nothing to plot
const now = ref(Date.now());
const clockTimer = window.setInterval(() => { now.value = Date.now(); }, 15_000);
const plotMessage = computed(() => {
	if (!selectedId.value) return 'Select a run';
	if (loadingDetail.value || traceLoading.value) return 'Loading the trace…';
	return profile.plotMessage(runData.value, now.value);
});

// ---- shared x-zoom (time) across every tile and the energy chart: a rubber-band box (when the tool is on)
// or the wheel on any plot sets one window; the hover time is shared the same way.
const zoomStart = ref<number | null>(null);
const zoomEnd = ref<number | null>(null);
const hoverT = ref<number | null>(null);
function onZoom(v: { start: number; end: number } | null) {
	zoomStart.value = v ? v.start : null; zoomEnd.value = v ? v.end : null;
}
// A new run changes the trace entirely: drop any stale zoom window.
watch(selectedId, () => onZoom(null));

// ---------------------------------------------------------------- open records
const openOperation = () => { if (selectedId.value) host.openRecord('manufacturing_operations', String(selectedId.value)); };
const openRecipe = () => { const id = detail.value?.fast_recipe_id?.id; if (id) host.openRecord('fast_recipes', String(id)); };
const openSample = () => { const id = detail.value?.sample_id?.sample_id; if (id) host.openRecord('physical_samples', String(id)); };
</script>

<template>
	<private-view :title="profile.heading">
		<div class="fd">
			<div v-if="loading" class="fd-spin big"><v-progress-circular indeterminate /></div>
			<div v-if="listError" class="err" role="alert">{{ listError }}</div>
			<div v-show="!loading" ref="layoutEl" class="layout" :class="{ stacked }"
				:style="{ gridTemplateColumns: gridCols, height: stacked ? 'auto' : availableHeight + 'px' }">
				<FastLists v-model:sample="sample" :profile="profile" :rows="rows" :selected-id="selectedId" :folded="folded" @select="selectOp" />
				<FastRunColumn v-model:tab="tab" :profile="profile" :code="detail?.pass_code ?? selectedRow?.pass_code ?? null" :quality="selectedRow?.quality ?? null"
					:detail="detail" :run-data="runData" :trace="trace" :loading="loadingDetail || traceLoading" :message="runError"
					:zoom-start="zoomStart" :zoom-end="zoomEnd" :cursor="hoverT" :zoom-tool="zoomTool" :busy="reloading" @run-changed="reloadRun"
					@open-operation="openOperation" @open-recipe="openRecipe" @open-sample="openSample" @zoom="onZoom" @hover="hoverT = $event" />
				<FastPlots v-model:tiles="tiles" v-model:zoom-tool="zoomTool" :trace="trace" :catalog="catalog" :message="plotMessage" :stacked="stacked" :bands="bands" :start-ms="startMs"
					:zoom-start="zoomStart" :zoom-end="zoomEnd" :cursor="hoverT" @zoom="onZoom" @hover="hoverT = $event" />
			</div>
		</div>
	</private-view>
</template>

<style scoped>
.fd { padding: 12px 16px; container-type: inline-size; }   /* the page reacts to its own width */
.big { padding: 40px; }
.err { margin-bottom: 8px; color: var(--theme--danger); font-size: var(--fs-sm, 12px); }
.layout { display: grid; gap: 12px; align-items: stretch; }
.layout.stacked { align-items: start; }
/* stacked (phone / narrow): one scrolling column, the lists bounded so hundreds of rows do not flood it */
.layout.stacked :deep(.part) { flex: none; }
.layout.stacked :deep(.list) { max-height: 40vh; flex: none; }
.layout.stacked :deep(.tabbody) { flex: none; overflow: visible; }
.layout.stacked :deep(.chart) { min-height: 200px; }
</style>
