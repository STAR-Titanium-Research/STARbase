<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { DataTable, FactList, LoadState, Section, StatTile, StatusBadge, errorText, useExplorerHost } from '@d1/ui';
import {
	DEFAULT_DRAFT, NOT_PROCESSING, STAT_ORDER, draftFromState, isOnline as onlineAt, isRunning as runningOf, nextDesiredState,
	queueCounts, recrawlFilter, resetBody, settingsPayload, totalQueued as totalOf, type CrawlerDraft,
} from './crawlerModel';
import { daemonFacts, daemonView, filesText, queueRow, statTiles, toggleLabel, toneWorthShowing } from './crawlerView';
import '../labels/form.css';

// The Force Crawler control panel (admins only; CrawlerPage gates it): start/pause the host-side daemon
// (scripts/force_orchestrator.py --daemon) through force_crawler_state, edit its sampling settings, see the
// queue, retry errors and recrawl. Ported from the Data Studio module d1-force-crawler.
const host = useExplorerHost();
const api = host.api;

const loading = ref(true);
const state = ref<Record<string, any> | null>(null); // force_crawler_state singleton
const counts = ref<Record<string, number>>({});
const recent = ref<any[]>([]);
const errors = ref<any[]>([]);
const saving = ref(false);
const loadError = ref<string | null>(null); // last poll failure (cleared by the next good poll)
const actionError = ref<string | null>(null); // last failed button action

// The form is only pushed to the server on Save, so typing does not fight the 5 s poll overwriting a field mid-keystroke.
const draft = ref<CrawlerDraft>({ ...DEFAULT_DRAFT });
const dirty = ref(false);

let timer: ReturnType<typeof setInterval> | undefined;

async function loadState() {
	const res = await api.get('/items/force_crawler_state');
	state.value = res.data.data;
	if (!dirty.value && state.value) draft.value = draftFromState(state.value);
}

async function loadQueue() {
	const res = await api.get('/items/machining_force_analysis', { params: { aggregate: { count: '*' }, groupBy: ['status'] } });
	counts.value = queueCounts(res.data.data);
}

async function loadRecent() {
	const [rRes, eRes] = await Promise.all([
		api.get('/items/machining_force_analysis', {
			params: {
				filter: { status: { _in: ['done', 'error'] } },
				sort: '-updated_at', limit: 12,
				fields: ['id', 'status', 'error_message', 'updated_at', 'peak_fz', 'operation_id.pass_code', 'operation_id.sample_id.sample_code'],
			},
		}),
		api.get('/items/machining_force_analysis', {
			params: {
				filter: { status: { _eq: 'error' } },
				sort: '-updated_at', limit: 20,
				fields: ['id', 'error_message', 'updated_at', 'operation_id.pass_code', 'operation_id.sample_id.sample_code'],
			},
		}),
	]);
	recent.value = rRes.data.data ?? [];
	errors.value = eRes.data.data ?? [];
}

// One refresh at a time: the 5 s timer skips a tick while the previous refresh is still running (a slow
// server would otherwise pile up overlapping requests), and nothing is written after unmount. allSettled so
// one failing request neither hides the others nor leaves `loading` stuck.
let refreshing = false;
let unmounted = false;
async function refreshAll() {
	if (refreshing || unmounted) return;
	refreshing = true;
	try {
		const results = await Promise.allSettled([loadState(), loadQueue(), loadRecent()]);
		if (unmounted) return;
		const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
		loadError.value = failed ? `Could not refresh the crawler status: ${errorText(failed.reason, 'request failed')}` : null;
	} finally {
		refreshing = false;
	}
}

onMounted(async () => {
	try {
		await refreshAll();
	} finally {
		loading.value = false;
	}
	if (!unmounted) timer = setInterval(refreshAll, 5000);
});
onBeforeUnmount(() => {
	unmounted = true;
	if (timer) clearInterval(timer);
});

// Run a button action: show its failure instead of an unhandled rejection.
async function act(fn: () => Promise<void>) {
	actionError.value = null;
	try {
		await fn();
	} catch (e) {
		actionError.value = errorText(e, 'request failed');
	}
}

const online = computed(() => onlineAt(state.value));
const running = computed(() => runningOf(state.value));
const total = computed(() => totalOf(counts.value));
const tiles = computed(() => statTiles(STAT_ORDER, counts.value));
const daemon = computed(() => daemonView(online.value, running.value));
const facts = computed(() => daemonFacts(state.value));
const errorRows = computed(() => errors.value.map(queueRow));
const recentRows = computed(() => recent.value.map(queueRow));

async function toggleRunning() {
	await act(async () => {
		await api.patch('/items/force_crawler_state', { desired_state: nextDesiredState(state.value) });
		await loadState();
	});
}

async function saveSettings() {
	saving.value = true;
	await act(async () => {
		await api.patch('/items/force_crawler_state', settingsPayload(draft.value));
		dirty.value = false;
		await loadState();
	});
	saving.value = false;
}

async function resetToPending(ids: string[]) {
	if (!ids.length) return 0;
	await api.patch('/items/machining_force_analysis', resetBody(ids));
	return ids.length;
}
async function retryOne(id: string) {
	await act(async () => {
		await resetToPending([id]);
		await refreshAll();
	});
}
// One batch request and one refresh, not N of each.
async function retryAllErrors() {
	await act(async () => {
		await resetToPending(errors.value.map((e) => e.id));
		await refreshAll();
	});
}

// Recrawl: reprocess specific operations / a whole sample's operations (matched by operation or sample code)
// or everything tracked: resets status to 'pending' so the running daemon (or the next --run) picks them up.
const recrawlQuery = ref('');
const recrawling = ref(false);
const recrawlResult = ref<string | null>(null);

async function recrawlMatching() {
	const q = recrawlQuery.value.trim();
	if (!q) return;
	recrawling.value = true;
	recrawlResult.value = null;
	await act(async () => {
		const res = await api.get('/items/machining_force_analysis', { params: { filter: recrawlFilter(q), limit: -1, fields: ['id'] } });
		const n = await resetToPending((res.data.data ?? []).map((r: any) => r.id));
		recrawlResult.value = n
			? `Queued ${n} file${n === 1 ? '' : 's'} matching "${q}" (files being processed now are left alone)`
			: `No idle files match "${q}"`;
		await refreshAll();
	});
	recrawling.value = false;
}

async function recrawlAll() {
	const busy = counts.value.processing ?? 0;
	if (!window.confirm(`Reprocess ALL ${total.value} tracked file(s)? This resets every row to pending${busy ? `, except the ${busy} being processed right now` : ''}.`)) return;
	recrawling.value = true;
	recrawlResult.value = null;
	await act(async () => {
		const res = await api.get('/items/machining_force_analysis', { params: { filter: NOT_PROCESSING, limit: -1, fields: ['id'] } });
		const n = await resetToPending((res.data.data ?? []).map((r: any) => r.id));
		recrawlResult.value = `Queued ${n} file(s)${busy ? `; ${busy} being processed were left alone` : ''}`;
		await refreshAll();
	});
	recrawling.value = false;
}
</script>

<template>
	<div class="fc">
		<p class="d1-note">Host-side .mat processing queue · {{ filesText(total) }} tracked</p>

		<LoadState v-if="loading" loading loading-text="Loading the crawler…" />

		<template v-else>
			<p v-if="loadError" class="banner bad" role="alert">{{ loadError }}</p>
			<p v-if="actionError" class="banner bad" role="alert">{{ actionError }}</p>
			<p v-if="!online" class="banner warn" role="status">
				<span>Daemon not detected (no heartbeat in the last 30s). Start it on the host:</span>
				<code>py scripts/force_orchestrator.py --daemon</code>
			</p>

			<div class="tiles" role="list" aria-label="Queue by state">
				<StatTile
					v-for="t in tiles"
					:key="t.key"
					role="listitem"
					:class="{ [`tone-${t.tone}`]: toneWorthShowing(t) }"
					:label="t.label"
					:value="t.value"
					:icon="t.icon"
				/>
			</div>

			<div class="cols">
				<Section title="Daemon">
					<template #actions>
						<span class="pill" :class="`tone-${daemon.tone}`">{{ daemon.label }}</span>
						<v-button x-small :kind="running ? 'warning' : 'normal'" @click="toggleRunning">
							<v-icon :name="running ? 'pause' : 'play_arrow'" x-small left />{{ toggleLabel(running) }}
						</v-button>
					</template>
					<FactList :facts="facts" :columns="1" />
				</Section>

				<Section title="Errors" :count="errors.length" :empty="!errors.length" empty-text="No errors.">
					<template v-if="errors.length" #actions>
						<v-button x-small secondary @click="retryAllErrors"><v-icon name="replay" x-small left />Retry all</v-button>
					</template>
					<DataTable>
						<thead><tr><th>File</th><th>Message</th><th /></tr></thead>
						<tbody>
							<tr v-for="e in errorRows" :key="e.id">
								<td class="mono">{{ e.label }}</td>
								<td class="msg">{{ e.message || '—' }}</td>
								<td class="actions"><v-button x-small secondary @click="retryOne(e.id)">Retry</v-button></td>
							</tr>
						</tbody>
					</DataTable>
				</Section>
			</div>

			<Section title="Settings">
				<template #actions>
					<v-button x-small :disabled="!dirty" :loading="saving" @click="saveSettings">{{ saving ? 'Saving…' : 'Save settings' }}</v-button>
				</template>
				<div class="group">
					<h3>Queue</h3>
					<div class="form">
						<label class="lf-field">Workers<input v-model.number="draft.workers" type="number" min="1" max="16" @input="dirty = true" /></label>
						<label class="lf-field">Throttle (s)<input v-model.number="draft.throttle_seconds" type="number" min="0" step="0.5" @input="dirty = true" /></label>
						<label class="lf-field wide">File scope (ILIKE)<input v-model="draft.file_like" placeholder="%10-AA-MF%" @input="dirty = true" /></label>
						<label class="lf-field wide">Operation code scope (ILIKE)<input v-model="draft.op_code_like" placeholder="%MT-F%" @input="dirty = true" /></label>
					</div>
				</div>
				<div class="group">
					<h3>Sampling <span class="when">applies to files processed after saving</span></h3>
					<div class="form">
						<label class="lf-field">Series points<input v-model.number="draft.series_points" type="number" min="100" step="100" @input="dirty = true" /></label>
						<label class="lf-field">FFT points<input v-model.number="draft.fft_points" type="number" min="100" step="100" @input="dirty = true" /></label>
						<label class="lf-field">FRM downsample (every Nth pt)<input v-model.number="draft.frm_downsample_step" type="number" min="1" step="1" @input="dirty = true" /></label>
						<label class="lf-field">FRM DPI<input v-model.number="draft.frm_dpi" type="number" min="72" step="6" @input="dirty = true" /></label>
						<label class="lf-field">Live cache points<input v-model.number="draft.live_cache_points" type="number" min="1000" step="1000" @input="dirty = true" /></label>
						<label class="lf-field">Pulses per rev<input v-model.number="draft.pulses_per_rev" type="number" min="1" step="1" @input="dirty = true" /></label>
					</div>
					<p class="d1-note">A map whose cut window has ≤ <b>Live cache points</b> is cached 1:1 and plotted at full resolution in Live mode; larger maps are decimated to this cap. Ops above ~5M points auto-route to a host-built Potree octree (LOD-streamed).</p>
				</div>
				<div class="group">
					<h3>Gridding &amp; octree <span class="when">applies to builds after saving</span></h3>
					<div class="form">
						<label class="lf-field">Grid density N (≤ 8192)<input v-model.number="draft.grid_density" type="number" min="16" max="8192" step="128" @input="dirty = true" /></label>
						<label class="lf-field">Grid method
							<select v-model="draft.grid_method" @change="dirty = true">
								<option value="splat">splat (Gaussian, GPU)</option>
								<option value="natural">natural (Delaunay)</option>
							</select>
						</label>
						<label class="lf-field">Octree auto-route threshold (pts)<input v-model.number="draft.octree_threshold" type="number" min="1000" step="100000" @input="dirty = true" /></label>
						<label class="lf-field">Octree min node px<input v-model.number="draft.octree_min_node_px" type="number" min="0.1" step="0.5" @input="dirty = true" /></label>
						<label class="lf-field">Octree budget cap (pts)<input v-model.number="draft.octree_budget_cap" type="number" min="1000000" step="1000000" @input="dirty = true" /></label>
						<label class="lf-check wide"><input v-model="draft.grid_pregen" type="checkbox" @change="dirty = true" /> Pre-build gridded octrees for big ops <span class="dim">(heavier crawl)</span></label>
					</div>
					<p class="d1-note">The interpolated grid fills the sparse spiral at deep zoom (N×N cells; <b>splat</b> is GPU-accelerated). Maps above the <b>auto-route threshold</b> default to the octree view. Lower <b>min node px</b> streams more detail; the <b>budget cap</b> bounds GPU memory.</p>
				</div>
			</Section>

			<Section title="Recrawl">
				<div class="recrawl">
					<label class="lf-field grow">Operation or sample code
						<input v-model="recrawlQuery" placeholder="Operation or sample code…" aria-label="Operation or sample code" @keyup.enter="recrawlMatching" />
					</label>
					<v-button small secondary :disabled="recrawling || !recrawlQuery.trim()" @click="recrawlMatching"><v-icon name="restart_alt" small left />Recrawl matches</v-button>
					<v-button small secondary kind="danger" :disabled="recrawling" @click="recrawlAll">Recrawl all</v-button>
				</div>
				<p v-if="recrawlResult" class="d1-note result" role="status">{{ recrawlResult }}</p>
			</Section>

			<Section title="Recent activity" :count="recent.length" :empty="!recent.length" empty-text="No activity yet.">
				<DataTable>
					<thead><tr><th>File</th><th>Status</th><th class="num">Updated</th></tr></thead>
					<tbody>
						<tr v-for="r in recentRows" :key="r.id">
							<td class="mono">{{ r.label }}</td>
							<td><StatusBadge kind="force" :value="r.status" /></td>
							<td class="num dim">{{ r.time }}</td>
						</tr>
					</tbody>
				</DataTable>
			</Section>
		</template>
	</div>
</template>

<style scoped>
.fc { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

/* A line above the panels that needs reading: drawn from the status inks, as the d1-note tones are. */
.banner {
	display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin: 0; padding: 8px 14px; border-radius: 10px;
	font-size: var(--fs-md); border: 1px solid color-mix(in srgb, var(--banner-ink) 40%, transparent);
	background: color-mix(in srgb, var(--banner-ink) 12%, transparent); color: var(--banner-ink);
}
.banner.warn { --banner-ink: var(--d1-warn); }
.banner.bad { --banner-ink: var(--d1-bad); }
.banner code {
	padding: 1px 8px; border-radius: 6px; font-size: var(--fs-sm); color: var(--theme--foreground); background: var(--d1-tile);
	font-family: var(--theme--fonts--monospace--font-family, monospace); overflow-wrap: anywhere;
}

/* The five queue states as one band of tiles, wrapping to fit the width. */
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 16px; align-items: start; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tone-danger :deep(.value) { color: var(--d1-bad); }
.tone-progress :deep(.value) { color: var(--d1-warn); }

/* The daemon's state as a pill in the panel lid: the badge's shape, in the status inks. */
.pill {
	padding: 1px 8px; border-radius: 99px; font-size: var(--fs-xs); font-weight: 700; line-height: 1.6; white-space: nowrap;
	color: var(--pill-ink); background: color-mix(in srgb, var(--pill-ink) 14%, transparent);
}
.pill.tone-success { --pill-ink: var(--d1-ok); }
.pill.tone-warning { --pill-ink: var(--d1-warn); }
.pill.tone-danger { --pill-ink: var(--d1-bad); }

.group + .group { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--d1-line); }
.group h3 { margin: 0 0 8px; font-size: var(--fs-md); font-weight: 650; }
.group .when { margin-left: 6px; font-size: var(--fs-sm); font-weight: 400; color: var(--d1-dim); }
.group .d1-note { margin-top: 8px; line-height: 1.5; }
.dim { color: var(--d1-dim); }
.form { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px 12px; }
.form .wide { grid-column: 1 / -1; }

.recrawl { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 8px 10px; }
.recrawl .grow { flex: 1 1 220px; }
.result { margin-top: 8px; }

.msg { color: var(--d1-bad); font-size: var(--fs-sm); overflow-wrap: anywhere; }
</style>
