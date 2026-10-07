<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRoute, useRouter } from 'vue-router';
import { recordRoute } from '@d1/ui';
import FastChart from './FastChart.vue';
import { type SeriesMeta, type Trace, loadTrace } from './fastCache';
import { buildOpMeta, buildRecipe, buildStats, dataQuality } from './fastMeta';

const api = useApi();
const route = useRoute();
const router = useRouter();

// Open the selected operation's record (its Explorer page; mirrors the force dashboard's "Open").
function openOpForm() { if (selectedId.value) router.push(recordRoute('manufacturing_operations', selectedId.value)); }
function openRecipe() { const r = recipe.value; if (r?.id) router.push(recordRoute('fast_recipes', r.id)); }

// ---------------------------------------------------------------- state
const loading = ref(true);
const rows = ref<any[]>([]);
const opSearch = ref('');
const selectedId = ref<string | null>(null);
const detail = ref<any | null>(null);
const loadingDetail = ref(false);

// Newest run first. operation_date is the real chronology; the pass_code starts with the
// day-of-month, so sorting by the code would scramble the order across months.
function byDateDesc(a: any, b: any): number {
	const ta = a.operation_date ? Date.parse(a.operation_date) : 0;
	const tb = b.operation_date ? Date.parse(b.operation_date) : 0;
	return tb - ta;
}

// rows.value is already sorted (once, at load), so filtering is a cheap pass with no re-sort.
const filteredOps = computed(() => {
	const q = opSearch.value.trim().toLowerCase();
	if (!q) return rows.value;
	return rows.value.filter((o) => (o.pass_code || '').toLowerCase().includes(q)
		|| (o.sample_id?.sample_code || '').toLowerCase().includes(q)
		|| (o.sintering_recipe_number || '').toLowerCase().includes(q));
});
// Debounce the search so the 10k-row filter runs after typing settles, not per keystroke.
const searchRaw = ref('');
let searchTimer = 0;
watch(searchRaw, (v) => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { opSearch.value = v; }, 160); });

// ---------------------------------------------------------------- layout (resizable + persisted)
const LAYOUT_KEY = 'd1-fast-dashboard-v1';
const colA = ref(280);
const dragging = ref(false);
const tiles = ref<Tile[]>([]);
interface Tile { id: number; series: string[]; span: 'sm' | 'wide' | 'tall' | 'big'; normalise: boolean; }
let tileSeq = 1;
// Either of the two left columns (operations list / operation detail) can be folded
// away to hand the plot grid the full width — mirrors the force dashboard.
const opsHidden = ref(false);
const detailHidden = ref(false);
// True until the first trace seeds the default category tiles; a saved non-empty
// layout suppresses that so we never clobber the user's arrangement.
let freshTiles = true;

let pendingSelect: string | null = null;
(function load() {
	try {
		const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
		if (typeof v.colA === 'number') colA.value = v.colA;
		if (Array.isArray(v.tiles) && v.tiles.length) { tiles.value = v.tiles; tileSeq = Math.max(...v.tiles.map((t: Tile) => t.id)) + 1; freshTiles = false; }
		if (typeof v.selectedId === 'string') pendingSelect = v.selectedId;
		if (typeof v.opsHidden === 'boolean') opsHidden.value = v.opsHidden;
		if (typeof v.detailHidden === 'boolean') detailHidden.value = v.detailHidden;
	} catch { /* ignore */ }
})();

watch([colA, tiles, selectedId, opsHidden, detailHidden], () => {
	localStorage.setItem(LAYOUT_KEY, JSON.stringify({
		colA: colA.value, tiles: tiles.value, selectedId: selectedId.value,
		opsHidden: opsHidden.value, detailHidden: detailHidden.value,
	}));
}, { deep: true });

let endColAResize: (() => void) | null = null;
function startColAResize(ev: PointerEvent) {
	ev.preventDefault();
	endColAResize?.();
	const startX = ev.clientX, start = colA.value;
	dragging.value = true;
	const move = (e: PointerEvent) => { colA.value = Math.min(460, Math.max(200, start + (e.clientX - startX))); };
	const up = () => { dragging.value = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); endColAResize = null; };
	endColAResize = up;
	window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

const layoutEl = ref<HTMLElement | null>(null);
const availableHeight = ref(700);
const layoutW = ref(1400);
// Below this the fixed 3-column layout (colA + colA + plot area) wouldn't fit —
// stack into one scrolling column instead, same threshold logic as the force
// dashboard (measured real width, not viewport, since Directus reserves side chrome).
const stacked = computed(() => layoutW.value < 900);
// Column track list, rebuilt from which of the two left columns are folded away so
// the plot area (1fr) always absorbs the freed space — collapse one and the plots
// widen; collapse both and they take the whole row.
const gridCols = computed(() => {
	if (stacked.value) return '1fr';
	const parts: string[] = [];
	if (!opsHidden.value) parts.push(`${colA.value}px`, '6px');
	if (!detailHidden.value) parts.push(`${colA.value}px`, '6px');
	parts.push('1fr');
	return parts.join(' ');
});
function measure() {
	if (!layoutEl.value) return;
	layoutW.value = layoutEl.value.getBoundingClientRect().width;
	availableHeight.value = Math.max(460, Math.floor(window.innerHeight - layoutEl.value.getBoundingClientRect().top - 20));
}
let ro: ResizeObserver | undefined;
onMounted(() => { ro = new ResizeObserver(measure); if (layoutEl.value) ro.observe(layoutEl.value); measure(); window.addEventListener('resize', measure); });
onBeforeUnmount(() => {
	ro?.disconnect(); window.removeEventListener('resize', measure);
	// Stop everything that could still write to this component: the search debounce, a column drag in
	// progress, the import poll, and any in-flight load (their results are dropped by opGen).
	clearTimeout(searchTimer);
	endColAResize?.();
	opGen++; listGen++;
	cancelPoll();
});

// ---------------------------------------------------------------- data load
const listError = ref<string | null>(null);
let listGen = 0;
onMounted(async () => {
	const gen = ++listGen;
	try {
		const res = await api.get('/items/manufacturing_operations', {
			params: {
				filter: { process_category: { _eq: 'sintering' } },
				fields: ['operation_id', 'pass_code', 'operation_date', 'operator_name',
					'sintering_max_temp_celsius', 'sintering_max_force_kn', 'sintering_recipe_number',
					'sample_id.sample_code', 'equipment_id.equipment_name',
					'fast_run.status', 'fast_run.n_rows'],
				sort: ['-operation_date'], limit: -1,
			},
		});
		// Precompute the stoplight once per row and sort by date ONCE here (not in the
		// filteredOps hot path) — with 10k+ rows, re-sorting/recomputing on every keystroke
		// or selection is what makes the list feel heavy.
		const mapped = (res.data?.data ?? []).map((o: any) => ({ ...o, id: o.operation_id, quality: dataQuality(o) }));
		mapped.sort(byDateDesc);
		if (gen !== listGen) return; // unmounted while loading
		rows.value = mapped;
	} catch (e: any) {
		if (gen !== listGen) return;
		listError.value = `Could not load the FAST operations: ${e?.response?.data?.errors?.[0]?.message || e?.message || 'request failed'}`;
	} finally {
		if (gen === listGen) {
			loading.value = false;
			await nextTick(); measure();
			const want = (route.query.operation as string) || pendingSelect;
			if (want) { const m = rows.value.find((o) => o.operation_id === want); if (m) selectOp(m); }
		}
	}
});

// ---------------------------------------------------------------- select + trace
const trace = ref<Trace | null>(null);
const fastRun = ref<any | null>(null);
const traceLoading = ref(false);
const importMsg = ref<string | null>(null);

// Every selection (and unmount) bumps opGen; a load that finishes after that is stale and must not
// write to detail/fastRun/trace, which now belong to the newer selection.
let opGen = 0;
function errMsg(e: any, fallback: string): string { return e?.response?.data?.errors?.[0]?.message || e?.message || fallback; }

async function selectOp(row: any) {
	const gen = ++opGen;
	cancelPoll(); // an import poll for the previous operation must not touch this one
	selectedId.value = row.operation_id;
	loadingDetail.value = true; detail.value = null; trace.value = null; fastRun.value = null; importMsg.value = null; traceLoading.value = false;
	try {
		const res = await api.get(`/items/manufacturing_operations/${row.operation_id}`, {
			params: {
				fields: ['*', 'equipment_id.equipment_name', 'method_id.method_name',
					'material_id.common_name', 'sample_id.sample_code', 'sample_id.nickname', 'sample_id.sample_id',
						'fast_recipe_id.id', 'fast_recipe_id.name', 'fast_recipe_id.program_nr',
						'fast_recipe_id.machine', 'fast_recipe_id.group_name', 'fast_recipe_id.source_file',
						'fast_recipe_id.target_temp_c', 'fast_recipe_id.target_force_kn', 'fast_recipe_id.hold_time_min'],
			},
		});
		if (gen !== opGen) return;
		detail.value = res.data.data;
		await loadFastRun(row.operation_id, gen);
	} catch (e: any) {
		if (gen === opGen) importMsg.value = `Could not load this operation: ${errMsg(e, 'request failed')}`;
	} finally { if (gen === opGen) loadingDetail.value = false; }
}

// Returns false when the result was dropped because another operation was selected meanwhile.
async function loadFastRun(operationId: string, gen: number = opGen): Promise<boolean> {
	const res = await api.get('/items/fast_run_data', {
		params: {
			filter: { operation_id: { _eq: operationId } },
			fields: ['id', 'status', 'machine_format', 'recipe', 'run_start', 'n_rows', 'duration_s', 'series', 'summary', 'directus_files_id', 'error_message', 'updated_at'],
			limit: 1,
		},
	});
	if (gen !== opGen) return false;
	fastRun.value = res.data?.data?.[0] ?? null;
	trace.value = null;
	if (fastRun.value?.status === 'done' && fastRun.value.directus_files_id) await loadTraceData(gen);
	return gen === opGen;
}

async function loadTraceData(gen: number = opGen) {
	const fr = fastRun.value;
	if (!fr?.directus_files_id) return;
	traceLoading.value = true;
	try {
		const catalog: SeriesMeta[] = fr.series || [];
		const loaded = await loadTrace(fr.directus_files_id, catalog, async () => {
			const res = await api.get(`/assets/${fr.directus_files_id}`, { responseType: 'text' });
			return res.data as string;
		});
		if (gen !== opGen) return;
		trace.value = loaded;
		// seed default series for empty tiles (first temperature + force)
		seedDefaultTiles();
	} catch (e: any) { if (gen === opGen) importMsg.value = errMsg(e, 'failed to load trace'); }
	finally { if (gen === opGen) traceLoading.value = false; }
}

// A row stuck at pending/processing for more than a short grace period almost
// always means the host FAST importer (fast_orchestrator.py --daemon) isn't running
// — nothing will ever claim it. Surface that instead of an indefinite spinner, so
// the failure mode is diagnosable when revisiting the op (pollImport's hint only
// fires during the active upload, not on a later visit).
const importStalled = computed(() => {
	const fr = fastRun.value;
	if (!fr || (fr.status !== 'pending' && fr.status !== 'processing')) return false;
	if (!fr.updated_at) return false;
	return Date.now() - new Date(fr.updated_at).getTime() > 30_000;
});

const catalog = computed<SeriesMeta[]>(() => fastRun.value?.series || []);
const groupedCatalog = computed(() => {
	const g: Record<string, SeriesMeta[]> = {};
	for (const s of catalog.value) (g[s.group] ||= []).push(s);
	return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0]));
});

// On first open (no saved layout), lay out a 2×3 grid of six tiles — one per main
// series *category* present in the trace — so the user immediately sees temperature,
// force, power, pressure, travel, electrical etc. rather than two empty tiles.
const SEED_GROUP_ORDER = ['temp', 'force', 'power', 'pressure', 'position', 'vacuum', 'speed', 'voltage', 'current', 'flow'];
const SEED_MAX_LINES: Record<string, number> = { temp: 6 };   // temp gets pyro + TCs; others stay focused
function seedDefaultTiles() {
	if (!trace.value || !freshTiles) return;
	// bucket the catalog by group, preserving catalog order within a group
	const byGroup: Record<string, string[]> = {};
	for (const c of catalog.value) (byGroup[c.group || 'other'] ||= []).push(c.key);
	// preferred categories first, then any remaining groups, capped at 6 tiles
	const groups = [
		...SEED_GROUP_ORDER.filter((g) => byGroup[g]?.length),
		...Object.keys(byGroup).filter((g) => !SEED_GROUP_ORDER.includes(g)),
	].slice(0, 6);
	if (!groups.length) return;
	tiles.value = groups.map((g) => ({
		id: tileSeq++, series: byGroup[g].slice(0, SEED_MAX_LINES[g] ?? 3), span: 'sm' as const, normalise: false,
	}));
	freshTiles = false;
}

// ---------------------------------------------------------------- plot tiles
const PALETTE = ['#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#475569', '#c026d3'];
function tileSeries(t: Tile) {
	const tr = trace.value; if (!tr) return [];
	return t.series.filter((k) => tr.series[k]).map((k, i) => {
		const s = tr.series[k];
		return { key: k, label: s.label, unit: s.unit, group: s.group, color: PALETTE[i % PALETTE.length], values: s.values };
	});
}
function addTile() { if (tiles.value.length < 6) tiles.value.push({ id: tileSeq++, series: [], span: 'sm', normalise: false }); }
function removeTile(id: number) { tiles.value = tiles.value.filter((t) => t.id !== id); }
const SPANS: Tile['span'][] = ['sm', 'wide', 'tall', 'big'];
function cycleSpan(t: Tile) { t.span = SPANS[(SPANS.indexOf(t.span) + 1) % SPANS.length]; }
function toggleSeries(t: Tile, key: string) {
	const i = t.series.indexOf(key);
	if (i >= 0) t.series.splice(i, 1); else t.series.push(key);
}

// ---- shared x-zoom (time) across every tile ----------------------------------
// Every tile shares the same time axis, so one zoom window drives them all — a
// rubber-band box (when the tool is on) or the wheel on any plot, ported from the
// force dashboard's ForceChart zoom.
const zoomStart = ref<number | null>(null);
const zoomEnd = ref<number | null>(null);
const rectZoomTool = ref(false);
const zoomed = computed(() => zoomStart.value != null || zoomEnd.value != null);
function onChartZoom(v: { start: number; end: number } | null) {
	if (!v) { zoomStart.value = null; zoomEnd.value = null; return; }
	zoomStart.value = v.start; zoomEnd.value = v.end;
}
function resetZoom() { zoomStart.value = null; zoomEnd.value = null; }
// A new operation changes the trace entirely — drop any stale zoom window.
watch(selectedId, resetZoom);

// right-click series picker
const menu = ref<{ tile: number; x: number; y: number } | null>(null);
function openMenu(ev: MouseEvent, t: Tile) {
	ev.preventDefault();
	if (!catalog.value.length) return;
	// Clamp so the fixed-width menu never renders off-screen on a narrow/mobile viewport.
	const menuW = 230;
	const x = Math.max(8, Math.min(ev.clientX, window.innerWidth - menuW - 8));
	const y = Math.max(8, Math.min(ev.clientY, window.innerHeight - 60));
	menu.value = { tile: t.id, x, y };
}
function closeMenu() { menu.value = null; }
const menuTile = computed(() => tiles.value.find((t) => t.id === menu.value?.tile) || null);
onMounted(() => window.addEventListener('click', closeMenu));
onBeforeUnmount(() => window.removeEventListener('click', closeMenu));

// ---------------------------------------------------------------- import
const fileInput = ref<HTMLInputElement | null>(null);
const archivePath = ref('');
const importing = ref(false);

// opId is the operation the user acted on; fastRun belongs to the CURRENTLY selected operation, so the
// patch is only valid while that is still opId (callers check this with the generation they started in).
async function upsertFastRun(opId: string, patch: any): Promise<void> {
	const existing = fastRun.value?.id;
	if (existing) await api.patch(`/items/fast_run_data/${existing}`, patch);
	else await api.post('/items/fast_run_data', { operation_id: opId, ...patch });
}

async function onUpload(ev: Event) {
	const f = (ev.target as HTMLInputElement).files?.[0];
	if (!f || !selectedId.value) return;
	const opId = selectedId.value, gen = opGen;
	importing.value = true; importMsg.value = 'Uploading…';
	try {
		const fd = new FormData();
		fd.append('title', `staging ${f.name}`);
		fd.append('file', f);
		const up = await api.post('/files', fd);
		const stagedId = up.data.data.id;
		if (gen !== opGen) return; // another operation was selected during the upload: do not attach it there
		await upsertFastRun(opId, { status: 'pending', staged_file: stagedId, import_archive_path: null });
		importMsg.value = 'Queued — waiting for the host importer…';
		await pollImport(opId, gen);
	} catch (e: any) {
		if (gen === opGen) importMsg.value = e?.response?.status === 403 ? 'Not permitted (admin only) to import.' : (e?.message || 'upload failed');
	} finally { importing.value = false; if (fileInput.value) fileInput.value.value = ''; }
}

async function onArchiveImport() {
	if (!archivePath.value.trim() || !selectedId.value) return;
	const opId = selectedId.value, gen = opGen;
	importing.value = true; importMsg.value = 'Queued archive import…';
	try {
		await upsertFastRun(opId, { status: 'pending', import_archive_path: archivePath.value.trim(), staged_file: null });
		await pollImport(opId, gen);
	} catch (e: any) {
		if (gen === opGen) importMsg.value = e?.response?.status === 403 ? 'Not permitted (admin only) to import.' : (e?.message || 'import failed');
	} finally { importing.value = false; }
}

// The poll sleeps on a timer that selectOp / unmount cancel, so it stops at once when the operation
// changes or the page goes away instead of running for up to three minutes and overwriting the
// newer operation's state.
let pollTimer = 0;
let pollWake: (() => void) | null = null;
function sleepCancellable(ms: number): Promise<void> {
	return new Promise((resolve) => { pollWake = resolve; pollTimer = window.setTimeout(() => { pollWake = null; resolve(); }, ms); });
}
function cancelPoll() { clearTimeout(pollTimer); const w = pollWake; pollWake = null; w?.(); }

async function pollImport(opId: string, gen: number) {
	const deadline = Date.now() + 3 * 60 * 1000;
	while (Date.now() < deadline) {
		await sleepCancellable(2500);
		if (gen !== opGen) return;
		let current: boolean;
		try { current = await loadFastRun(opId, gen); }
		catch (e: any) { if (gen === opGen) importMsg.value = `Could not check the import: ${errMsg(e, 'request failed')}`; return; }
		if (!current) return;
		const st = fastRun.value?.status;
		if (st === 'done') { importMsg.value = 'Imported.'; return; }
		if (st === 'error') { importMsg.value = `Import failed: ${fastRun.value?.error_message || 'unknown'}`; return; }
	}
	if (gen === opGen) importMsg.value = 'Still processing on the host — check back shortly (is the FAST importer running?).';
}

// ---------------------------------------------------------------- helpers
// In-app download: Directus serves files at /assets/<id>; ?download forces a save
// with the file's filename_download (the orchestrator named it <op_code>.csv).
function downloadFile(fileId: string) {
	const a = document.createElement('a');
	a.href = `/assets/${fileId}?download`;
	a.rel = 'noopener';
	document.body.appendChild(a); a.click(); a.remove();
}

function fmt(v: any, d = 1): string { if (v == null || v === '') return '—'; const n = Number(v); return Number.isFinite(n) ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(d)) : '—'; }
function fmtDate(v: string) { return v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
function fmtDur(s: any) { const n = Number(s); if (!Number.isFinite(n)) return '—'; const m = Math.floor(n / 60); return m >= 1 ? `${m}m ${Math.round(n % 60)}s` : `${Math.round(n)}s`; }

const opMeta = computed(() => buildOpMeta(detail.value));
const stats = computed(() => buildStats(detail.value, fastRun.value));
const recipe = computed(() => buildRecipe(detail.value));
</script>

<template>
	<private-view title="FAST Analysis">
		<div class="fd">
			<section class="hero">
				<span class="hero-badge"><v-icon name="whatshot" x-small /> FAST Analysis</span>
				<span class="hero-stat">{{ rows.length }} run{{ rows.length === 1 ? '' : 's' }}</span>
				<div class="hero-spacer"></div>
			</section>

			<div v-show="loading" class="loading"><v-progress-circular indeterminate /></div>
			<div v-if="listError" class="import-msg err">{{ listError }}</div>

			<div v-show="!loading" ref="layoutEl" class="layout" :class="{ dragging, stacked }"
				:style="{ gridTemplateColumns: gridCols, height: stacked ? 'auto' : availableHeight + 'px' }">
				<!-- COL 1: operations (collapsible away to the left) -->
				<div v-if="stacked || !opsHidden" class="panel">
					<div class="panel-head"><v-icon name="whatshot" small /><span>FAST operations</span><span class="chip">{{ filteredOps.length }}</span>
						<button v-if="!stacked" class="collapsebtn" title="Hide the operations column" @click="opsHidden = true"><v-icon name="chevron_left" x-small /></button>
					</div>
					<input v-model="searchRaw" class="search" placeholder="Search code / sample / recipe…" />
					<div class="list">
						<button v-for="o in filteredOps" :key="o.id" v-memo="[o.id === selectedId]"
							class="rowcard" :class="{ active: selectedId === o.id }" @click="selectOp(o)">
							<span class="mono sm">{{ o.pass_code || '—' }}</span>
							<span class="sub">{{ o.sample_id?.sample_code || '—' }} · {{ fmtDate(o.operation_date) }}</span>
							<span class="dot" :class="o.quality.level" :title="o.quality.label"></span>
						</button>
						<div v-if="!filteredOps.length" class="empty">No operations</div>
					</div>
				</div>

				<div v-if="!stacked && !opsHidden" class="resizer" @pointerdown="startColAResize"></div>

				<!-- COL 2: detail + import (collapsible away to the left) -->
				<div v-if="stacked || !detailHidden" class="col-stack">
					<div class="card info">
						<div class="info-head">
							<span><v-icon name="build" x-small /> Operation detail</span>
							<span class="ih-actions">
								<button v-if="selectedId" class="openbtn" title="Open the operation record" @click="openOpForm">Open <v-icon name="open_in_new" x-small /></button>
								<button v-if="!stacked" class="collapsebtn" title="Hide the detail column" @click="detailHidden = true"><v-icon name="chevron_left" x-small /></button>
							</span>
						</div>
						<template v-if="detail">
							<div class="info-code mono">{{ detail.pass_code || '—' }}</div>
							<div v-if="opMeta.length" class="kv">
								<template v-for="m in opMeta" :key="m[0]"><span>{{ m[0] }}</span><span>{{ m[1] }}</span></template>
							</div>
							<div class="stat-sep">Sinter cycle</div>
							<div class="statgrid">
								<div v-for="st in stats" :key="st.label" class="stat">
									<div class="s-top"><span class="s-val">{{ st.value }}</span><span class="s-unit">{{ st.unit }}</span></div>
									<span class="s-lab">{{ st.label }}<em class="s-src">{{ st.source }}</em></span>
								</div>
							</div>
						</template>
						<div v-else-if="loadingDetail" class="loading sm"><v-progress-circular indeterminate small /></div>
						<div v-else class="empty sm">Select an operation</div>
						<div v-if="importMsg" class="import-msg">{{ importMsg }}</div>
					</div>

						<!-- Recipe: a major, open-by-default dropdown card in the detail column. -->
						<details v-if="recipe" class="card recipe-card" open>
							<summary>
								<span class="rc-head"><v-icon name="science" small /> Recipe</span>
								<button class="openbtn" title="Open the recipe record" @click.stop="openRecipe">Open <v-icon name="open_in_new" x-small /></button>
							</summary>
							<div class="rc-name mono">{{ recipe.name }}</div>
							<div class="kv">
								<template v-if="recipe.machine"><span>Machine</span><span>FCT HP D {{ recipe.machine }}</span></template>
								<template v-if="recipe.programNr"><span>Program #</span><span>{{ recipe.programNr }}</span></template>
								<template v-if="recipe.tempC"><span>Target temp</span><span>{{ recipe.tempC }} °C</span></template>
								<template v-if="recipe.forceKn"><span>Target force</span><span>{{ recipe.forceKn }} kN</span></template>
								<template v-if="recipe.holdMin"><span>Hold time</span><span>{{ recipe.holdMin }} min</span></template>
								<template v-if="recipe.group"><span>Group</span><span>{{ recipe.group }}</span></template>
								<template v-if="recipe.source"><span>Source</span><span class="rc-src">{{ recipe.source }}</span></template>
							</div>
						</details>

				</div>

				<div v-if="!stacked && !detailHidden" class="resizer" @pointerdown="startColAResize"></div>

				<!-- COL 3: plot grid -->
				<div class="card plots">
					<div class="plots-head">
						<span class="graphs-title"><v-icon name="show_chart" small /> Plots</span>
						<span class="plots-actions">
							<button v-if="!stacked && opsHidden" class="expandbtn" title="Show the operations column" @click="opsHidden = false"><v-icon name="chevron_right" x-small /> Operations</button>
							<button v-if="!stacked && detailHidden" class="expandbtn" title="Show the detail column" @click="detailHidden = false"><v-icon name="chevron_right" x-small /> Detail</button>
							<button class="btn icobtn" :class="{ on: rectZoomTool }" title="Rectangular zoom — drag a box on any plot" :disabled="!trace" @click="rectZoomTool = !rectZoomTool"><v-icon name="crop_free" x-small /></button>
							<button class="btn" :disabled="!zoomed" title="Reset zoom on all plots" @click="resetZoom"><v-icon name="restart_alt" x-small /> Reset zoom</button>
							<button class="btn" :disabled="tiles.length >= 6 || !trace" @click="addTile"><v-icon name="add" x-small /> Add plot</button>
						</span>
					</div>
					<div v-if="!detail" class="empty">Select an operation</div>
					<div v-else-if="traceLoading" class="loading sm"><v-progress-circular indeterminate small /> loading trace…</div>
					<div v-else-if="!trace" class="empty">No trace — import a CSV to plot.</div>
					<div v-else class="plot-grid">
						<div v-for="t in tiles" :key="t.id" class="plot-tile" :class="t.span" @contextmenu="openMenu($event, t)">
							<div class="tile-head">
								<span class="tile-title">{{ t.series.length ? t.series.length + ' series' : 'right-click to pick series' }}</span>
								<span class="tile-actions">
									<button class="ib" title="Pick series (also: right-click / long-press the tile)" @click.stop="openMenu($event, t)"><v-icon name="playlist_add_check" x-small /></button>
									<button class="ib" :class="{ on: t.normalise }" title="Normalise each series" @click.stop="t.normalise = !t.normalise">≈</button>
									<button class="ib" title="Resize" @click.stop="cycleSpan(t)"><v-icon name="aspect_ratio" x-small /></button>
									<button class="ib" title="Remove" @click.stop="removeTile(t.id)"><v-icon name="close" x-small /></button>
								</span>
							</div>
							<FastChart v-if="t.series.length" :time="trace.time" :series="tileSeries(t)" :normalise="t.normalise"
								:view-start="zoomStart" :view-end="zoomEnd" :zoom-tool="rectZoomTool" @zoom="onChartZoom" />
							<div v-else class="tile-empty" @click.stop="openMenu($event, t)">＋ pick series</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- right-click series picker -->
		<div v-if="menu && menuTile" class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
			<div class="ctx-head">Series</div>
			<div class="ctx-body">
				<div v-for="[grp, items] in groupedCatalog" :key="grp" class="ctx-group">
					<div class="ctx-grp-label">{{ grp }}</div>
					<label v-for="s in items" :key="s.key" class="ctx-item">
						<input type="checkbox" :checked="menuTile.series.includes(s.key)" @change="toggleSeries(menuTile, s.key)" />
						<span>{{ s.label }}</span><em>{{ s.unit }}</em>
					</label>
				</div>
			</div>
		</div>
	</private-view>
</template>

<style scoped>
.fd { padding: 20px 24px 40px; font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif); color: var(--theme--foreground, #1e293b);
	container-type: inline-size; }   /* size the plot grid to the real content width, not the viewport */
/* Thin horizontal banner: title + counts on the left. */
.hero { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 6px 14px; border-radius: 12px;
	color: #fff; background: linear-gradient(120deg, #b91c1c, #ea580c); box-shadow: 0 8px 20px -12px rgba(234,88,12,.6); flex-wrap: wrap; }
.hero-badge { display: inline-flex; align-items: center; gap: 7px; font-weight: 750; font-size: 14px; }
.hero-badge :deep(.v-icon) { --v-icon-color: #fff; }
.hero-stat { font-size: 12px; font-weight: 600; opacity: 0.9; }
.hero-spacer { flex: 1 1 auto; }
.loading { display: grid; place-items: center; padding: 40px; } .loading.sm { padding: 16px; gap: 8px; grid-auto-flow: column; }
.layout { display: grid; gap: 0; align-items: stretch; overflow: hidden; }
.layout.stacked { align-items: start; overflow: visible; gap: 14px; }
.layout.dragging { cursor: col-resize; user-select: none; }
.resizer { width: 6px; cursor: col-resize; position: relative; }
.resizer::after { content: ''; position: absolute; inset: 0 2px; border-radius: 2px; background: var(--theme--border-color-subdued, #e7ebf0); }

/* Stacked (mobile / narrow) layout: the fixed 3-column grid collapses to one
   scrolling column. Bound the operations list so 500 rows don't flood the page,
   and let the detail column flow naturally instead of double-scrolling. */
.layout.stacked .list { max-height: 40vh; flex: none; }
.layout.stacked .col-stack { overflow: visible; }
.layout.stacked .plots { min-height: 420px; }

.panel, .card { background: var(--theme--background, #fff); border: 1px solid var(--theme--border-color-subdued, #e7ebf0); border-radius: 16px; min-height: 0; }
.panel { display: flex; flex-direction: column; padding: 12px; }
.panel-head { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--theme--foreground-subdued, #6b7684); margin-bottom: 8px; }
.chip { margin-left: auto; background: var(--theme--background-subdued, #f1f5f9); border-radius: 99px; padding: 1px 8px; font-size: 11px; }
.search { width: 100%; box-sizing: border-box; padding: 6px 9px; border: 1px solid var(--theme--border-color, #d1d9e6); border-radius: 8px; font: inherit; font-size: 13px; margin-bottom: 8px; }
.list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; }
.rowcard { display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; text-align: left; border: 1px solid transparent; background: var(--theme--background-subdued, #f7f9fb); border-radius: 10px; padding: 7px 10px; cursor: pointer; }
.rowcard:hover { border-color: var(--theme--border-color, #d1d9e6); }
.rowcard.active { border-color: #ea580c; background: color-mix(in srgb, #ea580c 8%, transparent); }
.rowcard .mono { font-family: 'SF Mono', Menlo, Consolas, monospace; font-weight: 650; font-size: 12.5px; }
.rowcard .sub { grid-column: 1; color: var(--theme--foreground-subdued, #6b7684); font-size: 11px; }
/* Data-quality stoplight dot (green complete · yellow partial · blue importing · red none),
   small, in the top-right corner of the row. */
.rowcard { position: relative; }
.rowcard .dot { position: absolute; top: 7px; right: 8px; width: 6px; height: 6px; border-radius: 99px; }
.rowcard .dot.green { color: #16a34a; background: #16a34a; }
.rowcard .dot.yellow { color: #d97706; background: #f59e0b; }
.rowcard .dot.blue { color: #2563eb; background: #3b82f6; }
.rowcard .dot.red { color: #dc2626; background: #ef4444; }
/* Cheap virtualisation so the full (10k+) list scrolls smoothly without windowing JS. */
.rowcard { content-visibility: auto; contain-intrinsic-size: auto 46px; }
/* Recipe dropdown in the detail panel. */
/* Recipe: a major dropdown card in the detail column (open by default). */
.recipe-card { padding: 12px 14px; }
.recipe-card > summary { display: flex; align-items: center; justify-content: space-between; cursor: pointer; list-style: none; font-weight: 750; font-size: 13px; color: var(--theme--foreground, #1f2733); }
.recipe-card > summary::-webkit-details-marker { display: none; }
.recipe-card > summary::after { content: '▾'; margin-left: auto; opacity: .5; transition: transform .15s; }
.recipe-card:not([open]) > summary::after { transform: rotate(-90deg); }
.recipe-card .rc-head { display: inline-flex; align-items: center; gap: 7px; }
.recipe-card .rc-name { margin: 10px 0 8px; font-size: 12.5px; font-weight: 650; color: var(--theme--primary, #ea580c); word-break: break-word; }
.recipe-card .rc-src { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 10px; word-break: break-all; }
.mono.sm { font-size: 12px; } .empty { color: var(--theme--foreground-subdued, #98a2b3); font-size: 12px; padding: 12px; text-align: center; } .empty.sm { padding: 8px; }

.col-stack { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; }
.card.info { padding: 14px 16px; }
.info-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--theme--foreground-subdued, #6b7684); margin-bottom: 10px; }
.ih-actions { display: inline-flex; align-items: center; gap: 4px; }
.openbtn { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--theme--border-color, #d1d9e6); background: var(--theme--background-subdued, #f1f5f9); color: var(--theme--primary, #1d4ed8); font: inherit; font-size: 10px; font-weight: 700; text-transform: none; letter-spacing: 0; padding: 2px 7px; border-radius: 7px; cursor: pointer; }
.openbtn:hover { background: var(--theme--background, #fff); }
.collapsebtn, .expandbtn { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--theme--border-color, #d1d9e6); background: var(--theme--background-subdued, #f1f5f9); color: var(--theme--foreground-subdued, #6b7684); cursor: pointer; border-radius: 7px; padding: 2px 6px; font: inherit; font-size: 10px; font-weight: 700; text-transform: none; letter-spacing: 0; }
.collapsebtn:hover, .expandbtn:hover { background: var(--theme--background, #fff); color: var(--theme--foreground, #334155); }
.panel-head .collapsebtn { margin-left: auto; }
.plots-actions { display: inline-flex; align-items: center; gap: 6px; }
.btn.icobtn { padding: 6px 8px; }
.btn.icobtn.on { background: #0ea5e9; border-color: #0ea5e9; color: #fff; }
.info-code { font-size: 13px; margin-bottom: 10px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 12.5px; }
.kv span:nth-child(odd) { color: var(--theme--foreground-subdued, #6b7684); }
.kv span:nth-child(even) { font-weight: 600; text-align: right; }
.stat-sep { margin: 12px 0 8px; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--theme--foreground-subdued, #98a2b3); border-top: 1px solid var(--theme--border-color-subdued, #eef1f5); padding-top: 9px; }
.statgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { background: var(--theme--background-subdued, #f7f9fb); border: 1px solid var(--theme--border-color-subdued, #e7ebf0); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.s-top { display: flex; align-items: baseline; gap: 4px; } .s-val { font-size: 15px; font-weight: 750; font-variant-numeric: tabular-nums; } .s-unit { font-size: 10px; color: var(--theme--foreground-subdued, #94a3b8); }
.s-lab { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--theme--foreground-subdued, #6b7684); font-weight: 600; }
/* Provenance of each stat: measured off the trace, recorded from the machine, or QA log. */
.s-src { display: block; font-style: normal; font-size: 9px; font-weight: 400; opacity: .55; text-transform: uppercase; letter-spacing: .03em; }
.trace-meta { font-size: 12px; margin-bottom: 8px; } .trace-meta .ok { color: #15803d; display: inline-flex; align-items: center; gap: 4px; } .trace-meta.muted { color: var(--theme--foreground-subdued, #98a2b3); }
.trace-meta.warn { color: #b45309; display: inline-flex; align-items: center; gap: 4px; }
.btn.dl { margin-top: 6px; }
.import-row { display: flex; gap: 6px; margin-bottom: 6px; } .import-row .search { margin-bottom: 0; flex: 1 1 auto; min-width: 0; }
.btn { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; padding: 6px 11px; border-radius: 8px; white-space: nowrap;
	color: var(--theme--foreground, #334155); background: var(--theme--background-subdued, #f1f5f9); border: 1px solid var(--theme--border-color, #d1d9e6); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.import-msg.err { color: var(--theme--danger, #c62828); font-style: normal; }
.import-msg { font-size: 11px; color: var(--theme--foreground-subdued, #6b7684); font-style: italic; margin-top: 4px; }

.plots { display: flex; flex-direction: column; padding: 12px; min-height: 0; }
.plots-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.graphs-title { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--theme--foreground-subdued, #6b7684); }
/* Default: two columns of plots (so a fresh open shows a 2×3 category grid). */
.plot-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(2, 1fr); grid-auto-rows: 1fr; gap: 10px; overflow: auto; }
.plot-tile { border: 1px solid var(--theme--border-color-subdued, #e7ebf0); border-radius: 12px; padding: 6px 8px; display: flex; flex-direction: column; min-height: 180px; min-width: 0; background: var(--theme--background, #fff); }
.plot-tile.wide { grid-column: span 2; } .plot-tile.tall { grid-row: span 2; } .plot-tile.big { grid-column: span 2; grid-row: span 2; }

/* Tablet/narrow: 2 plot columns (wide/big still span both; tall keeps its 2-row span). */
@container (max-width: 700px) {
	.plot-grid { grid-template-columns: repeat(2, 1fr); }
}
/* Phone: a single plot column — spans would just waste width/height, so collapse them. */
@container (max-width: 460px) {
	.plot-grid { grid-template-columns: 1fr; }
	.plot-tile.wide, .plot-tile.tall, .plot-tile.big { grid-column: span 1; grid-row: span 1; }
}
.tile-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-bottom: 2px; min-width: 0; }
.tile-title { font-size: 10.5px; font-weight: 650; color: var(--theme--foreground-subdued, #6b7684); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-actions { display: flex; gap: 2px; flex: 0 0 auto; }
.ib { border: 0; background: transparent; cursor: pointer; color: var(--theme--foreground-subdued, #94a3b8); border-radius: 6px; padding: 2px 5px; font-size: 12px; font-weight: 700; }
.ib:hover { background: var(--theme--background-subdued, #eef2f7); } .ib.on { color: #7c3aed; background: color-mix(in srgb, #7c3aed 12%, transparent); }
.tile-empty { flex: 1; display: grid; place-items: center; color: var(--theme--foreground-subdued, #a4adba); font-size: 12px; cursor: pointer; }

.ctx { position: fixed; z-index: 50; background: var(--theme--background, #fff); border: 1px solid var(--theme--border-color, #d1d9e6); border-radius: 10px; box-shadow: 0 10px 30px rgba(15,23,42,.2); width: 230px; max-height: 60vh; display: flex; flex-direction: column; }
.ctx-head { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--theme--foreground-subdued, #94a3b8); padding: 8px 12px 4px; }
.ctx-body { overflow-y: auto; padding: 2px 0 6px; }
.ctx-grp-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #b91c1c; padding: 6px 12px 2px; }
.ctx-item { display: flex; align-items: center; gap: 7px; padding: 3px 12px; font-size: 12px; cursor: pointer; }
.ctx-item:hover { background: var(--theme--background-subdued, #f5f7fa); } .ctx-item em { margin-left: auto; color: var(--theme--foreground-subdued, #a4adba); font-style: normal; font-size: 10px; }
</style>
