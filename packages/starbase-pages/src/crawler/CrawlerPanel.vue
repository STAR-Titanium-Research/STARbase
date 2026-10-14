<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { errorText, useExplorerHost } from '@d1/ui';
import {
	DEFAULT_DRAFT, NOT_PROCESSING, STAT_ORDER, draftFromState, fmtTime, isOnline as onlineAt, isRunning as runningOf, nextDesiredState, opLabel,
	queueCounts, recrawlFilter, resetBody, settingsPayload, totalQueued as totalOf, type CrawlerDraft,
} from './crawlerModel';

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
const stats = computed(() => STAT_ORDER.map((s) => ({ key: s, label: s, value: counts.value[s] ?? 0 })));

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
		<section class="hero">
			<h1>Force Crawler</h1>
			<p>Host-side .mat processing queue · {{ total }} file{{ total === 1 ? '' : 's' }} tracked</p>
		</section>

		<p v-if="loading" class="fc-state" role="status">Loading…</p>

		<template v-else>
			<div v-if="loadError" class="banner err" role="alert">{{ loadError }}</div>
			<div v-if="actionError" class="banner err" role="alert">{{ actionError }}</div>
			<div v-if="!online" class="banner">
				<span>Daemon not detected (no heartbeat in the last 30s). Start it on the host:</span>
				<code>py scripts/force_orchestrator.py --daemon</code>
			</div>

			<div class="row two">
				<div class="card status-card">
					<div class="status-head">
						<span class="dot" :class="{ on: online }" />
						<span class="status-label">{{ online ? 'Daemon online' : 'Daemon offline' }}</span>
						<button type="button" class="runbtn" :class="{ running }" @click="toggleRunning">{{ running ? 'Pause' : 'Start' }}</button>
					</div>
					<div class="kv">
						<span>Desired state</span><span>{{ state?.desired_state ?? '—' }}</span>
						<span>PID</span><span>{{ state?.daemon_pid ?? '—' }}</span>
						<span>Started</span><span>{{ fmtTime(state?.daemon_started_at) }}</span>
						<span>Heartbeat</span><span>{{ fmtTime(state?.last_heartbeat_at) }}</span>
						<span>Last discover</span><span>{{ fmtTime(state?.last_discover_at) }}</span>
						<span>Activity</span><span class="activity">{{ state?.current_activity || '—' }}</span>
						<span>Session done / err</span><span>{{ state?.processed_count ?? 0 }} / {{ state?.error_count ?? 0 }}</span>
					</div>
				</div>

				<div class="stats">
					<div v-for="st in stats" :key="st.key" class="stat" :class="`s-${st.key}`">
						<span class="s-val">{{ st.value }}</span>
						<span class="s-lab">{{ st.label }}</span>
					</div>
				</div>
			</div>

			<div class="row two">
				<div class="card settings">
					<div class="card-head">Settings</div>
					<div class="form">
						<label>Workers<input v-model.number="draft.workers" type="number" min="1" max="16" @input="dirty = true" /></label>
						<label>Throttle (s)<input v-model.number="draft.throttle_seconds" type="number" min="0" step="0.5" @input="dirty = true" /></label>
						<label class="wide">File scope (ILIKE)<input v-model="draft.file_like" placeholder="%10-AA-MF%" @input="dirty = true" /></label>
						<label class="wide">Operation code scope (ILIKE)<input v-model="draft.op_code_like" placeholder="%MT-F%" @input="dirty = true" /></label>
					</div>
					<div class="form-sep">Sampling (applies to files processed after saving)</div>
					<div class="form">
						<label>Series points<input v-model.number="draft.series_points" type="number" min="100" step="100" @input="dirty = true" /></label>
						<label>FFT points<input v-model.number="draft.fft_points" type="number" min="100" step="100" @input="dirty = true" /></label>
						<label>FRM downsample (every Nth pt)<input v-model.number="draft.frm_downsample_step" type="number" min="1" step="1" @input="dirty = true" /></label>
						<label>FRM DPI<input v-model.number="draft.frm_dpi" type="number" min="72" step="6" @input="dirty = true" /></label>
						<label>Live cache points<input v-model.number="draft.live_cache_points" type="number" min="1000" step="1000" @input="dirty = true" /></label>
						<label>Pulses per rev<input v-model.number="draft.pulses_per_rev" type="number" min="1" step="1" @input="dirty = true" /></label>
						<p class="note">A map whose cut window has ≤ <b>Live cache points</b> is cached 1:1 and plotted at full resolution in Live mode; larger maps are decimated to this cap. Ops above ~5M points auto-route to a host-built Potree octree (LOD-streamed).</p>
					</div>
					<div class="form-sep">Gridding &amp; octree (applies to builds after saving)</div>
					<div class="form">
						<label>Grid density N (≤ 8192)<input v-model.number="draft.grid_density" type="number" min="16" max="8192" step="128" @input="dirty = true" /></label>
						<label>Grid method
							<select v-model="draft.grid_method" @change="dirty = true">
								<option value="splat">splat (Gaussian, GPU)</option>
								<option value="natural">natural (Delaunay)</option>
							</select>
						</label>
						<label>Octree auto-route threshold (pts)<input v-model.number="draft.octree_threshold" type="number" min="1000" step="100000" @input="dirty = true" /></label>
						<label>Octree min node px<input v-model.number="draft.octree_min_node_px" type="number" min="0.1" step="0.5" @input="dirty = true" /></label>
						<label>Octree budget cap (pts)<input v-model.number="draft.octree_budget_cap" type="number" min="1000000" step="1000000" @input="dirty = true" /></label>
						<label class="chk wide"><input v-model="draft.grid_pregen" type="checkbox" @change="dirty = true" /> Pre-build gridded octrees for big ops <span class="u">(heavier crawl)</span></label>
						<p class="note">The interpolated grid fills the sparse spiral at deep zoom (N×N cells; <b>splat</b> is GPU-accelerated). Maps above the <b>auto-route threshold</b> default to the octree view. Lower <b>min node px</b> streams more detail; the <b>budget cap</b> bounds GPU memory.</p>
					</div>
					<button type="button" class="savebtn" :disabled="!dirty || saving" @click="saveSettings">{{ saving ? 'Saving…' : 'Save settings' }}</button>

					<div class="form-sep">Recrawl</div>
					<div class="recrawl-row">
						<input v-model="recrawlQuery" class="recrawl-input" placeholder="Operation or sample code…" aria-label="Operation or sample code" @keyup.enter="recrawlMatching" />
						<button type="button" class="ghostbtn" :disabled="recrawling || !recrawlQuery.trim()" @click="recrawlMatching">Recrawl matches</button>
						<button type="button" class="ghostbtn warn" :disabled="recrawling" @click="recrawlAll">Recrawl all</button>
					</div>
					<div v-if="recrawlResult" class="note" role="status">{{ recrawlResult }}</div>
				</div>

				<div class="card errors">
					<div class="card-head">
						Errors <span class="chip">{{ errors.length }}</span>
						<button v-if="errors.length" type="button" class="linkbtn" @click="retryAllErrors">Retry all</button>
					</div>
					<div class="list">
						<div v-for="e in errors" :key="e.id" class="errrow">
							<div class="errrow-top">
								<span class="mono">{{ opLabel(e) }}</span>
								<button type="button" class="ghostbtn small" @click="retryOne(e.id)">Retry</button>
							</div>
							<div class="errmsg">{{ e.error_message || '—' }}</div>
						</div>
						<div v-if="!errors.length" class="empty">No errors</div>
					</div>
				</div>
			</div>

			<div class="card activity-card">
				<div class="card-head">Recent activity</div>
				<div class="list">
					<div v-for="r in recent" :key="r.id" class="actrow">
						<span class="dot2" :class="`s-${r.status}`" />
						<span class="mono">{{ opLabel(r) }}</span>
						<span class="actstatus">{{ r.status }}</span>
						<span class="acttime">{{ fmtTime(r.updated_at) }}</span>
					</div>
					<div v-if="!recent.length" class="empty">No activity yet</div>
				</div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.fc { display: flex; flex-direction: column; gap: 14px; }
.hero h1 { margin: 0; font-size: var(--fs-2xl, 22px); font-weight: 700; }
.hero p { margin: 4px 0 0; font-size: var(--fs-md, 13px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.fc-state { margin: 0; color: var(--d1-dim, var(--theme--foreground-subdued)); }

.banner {
	display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-radius: 10px; font-size: var(--fs-md, 13px);
	border: 1px solid color-mix(in srgb, var(--d1-warn, #d97706) 40%, transparent); background: color-mix(in srgb, var(--d1-warn, #d97706) 12%, transparent);
	color: var(--d1-warn, #92400e);
}
.banner.err { border-color: color-mix(in srgb, var(--d1-bad, #dc2626) 40%, transparent); background: color-mix(in srgb, var(--d1-bad, #dc2626) 12%, transparent); color: var(--d1-bad, #b91c1c); }
.banner code { background: var(--d1-tile, #1e293b); color: inherit; padding: 2px 8px; border-radius: 6px; font-size: var(--fs-sm, 12px); }

.card { background: var(--d1-surface, var(--theme--background)); border: 1px solid var(--d1-line, var(--theme--border-color-subdued)); border-radius: var(--d1-radius, 12px); padding: 14px 16px; }
.card-head {
	display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: var(--fs-xs, 11px); font-weight: 700;
	text-transform: uppercase; letter-spacing: 0.05em; color: var(--d1-dim, var(--theme--foreground-subdued));
}

.row.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.status-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--d1-bad, #dc2626); flex: 0 0 auto; }
.dot.on { background: var(--d1-ok, #16a34a); box-shadow: 0 0 0 3px color-mix(in srgb, var(--d1-ok, #16a34a) 25%, transparent); }
.status-label { flex: 1; font-size: var(--fs-lg, 15px); font-weight: 700; }
.runbtn {
	border: 0; cursor: pointer; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 700; padding: 6px 14px; border-radius: 8px;
	color: var(--d1-on-accent, #fff); background: var(--d1-ok, #16a34a);
}
.runbtn.running { background: var(--d1-warn, #d97706); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: var(--fs-md, 13px); }
.kv span:nth-child(odd) { color: var(--d1-dim, var(--theme--foreground-subdued)); white-space: nowrap; }
.kv span:nth-child(even) { font-weight: 600; text-align: right; word-break: break-word; }
.activity { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-xs, 11px); }

.stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
.stat {
	background: var(--d1-tile, var(--theme--background-subdued)); border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 10px; padding: 14px 8px; display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.s-val { font-size: var(--fs-2xl, 22px); font-weight: 700; font-variant-numeric: tabular-nums; }
.s-lab { font-size: var(--fs-xs, 11px); text-transform: uppercase; letter-spacing: 0.05em; color: var(--d1-dim, var(--theme--foreground-subdued)); font-weight: 600; }
.stat.s-pending .s-val { color: var(--d1-dim, #94a3b8); }
.stat.s-processing .s-val { color: var(--d1-warn, #d97706); }
.stat.s-done .s-val { color: var(--d1-ok, #16a34a); }
.stat.s-error .s-val { color: var(--d1-bad, #dc2626); }
.stat.s-skipped .s-val { color: var(--d1-dim, #64748b); }

.form-sep {
	margin: 4px 0 8px; padding-top: 8px; border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	font-size: var(--fs-xs, 11px); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--d1-dim, var(--theme--foreground-subdued));
}
.form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; margin-bottom: 12px; }
.form label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.form label.wide { grid-column: 1 / -1; }
.form label.chk { flex-direction: row; align-items: center; gap: 8px; font-size: var(--fs-md, 13px); color: inherit; }
.form label.chk input { width: 16px; height: 16px; margin: 0; accent-color: var(--d1-accent, var(--theme--primary)); }
.form .u { color: var(--d1-dim, var(--theme--foreground-subdued)); font-weight: 400; }
.form input:not([type='checkbox']), .form select, .recrawl-input {
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 400; min-width: 0; padding: 6px 10px; border-radius: 8px;
	border: 1px solid var(--theme--border-color); background: var(--theme--form--field--input--background, var(--theme--background)); color: var(--theme--foreground);
}
.note { grid-column: 1 / -1; margin: 2px 0 6px; font-size: var(--fs-sm, 12px); line-height: 1.5; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.savebtn {
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 700; cursor: pointer; border: 0; border-radius: 8px; padding: 7px 16px;
	color: var(--d1-on-accent, #fff); background: var(--d1-accent, var(--theme--primary));
}
.savebtn:disabled { opacity: 0.4; cursor: default; }

.recrawl-row { display: flex; gap: 8px; flex-wrap: wrap; }
.recrawl-input { flex: 1 1 160px; }
.ghostbtn {
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 700; cursor: pointer; white-space: nowrap; padding: 6px 12px; border-radius: 8px;
	border: 1px solid var(--d1-line, var(--theme--border-color)); background: var(--d1-tile, transparent); color: var(--theme--foreground);
}
.ghostbtn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.ghostbtn.warn { color: var(--d1-warn, #b45309); }
.ghostbtn.small { padding: 2px 8px; font-size: var(--fs-xs, 11px); }
.ghostbtn:disabled { opacity: 0.45; cursor: default; }

.chip {
	font-size: var(--fs-xs, 11px); font-weight: 700; color: var(--d1-bad, #dc2626); background: color-mix(in srgb, var(--d1-bad, #dc2626) 12%, transparent);
	padding: 1px 7px; border-radius: 99px;
}
.linkbtn {
	margin-left: auto; border: 0; background: none; cursor: pointer; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 700;
	color: var(--d1-accent, var(--theme--primary)); text-transform: none; letter-spacing: 0;
}
.errors .list, .activity-card .list { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.errrow { background: var(--d1-tile, var(--theme--background-subdued)); border-radius: 8px; padding: 8px 10px; }
.errrow-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.errmsg { margin-top: 4px; font-size: var(--fs-xs, 11px); color: var(--d1-bad, #b91c1c); word-break: break-word; }

.actrow { display: flex; align-items: center; gap: 10px; padding: 4px 2px; font-size: var(--fs-md, 13px); }
.dot2 { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--d1-dim, #94a3b8); }
.dot2.s-processing { background: var(--d1-warn, #d97706); }
.dot2.s-done { background: var(--d1-ok, #16a34a); }
.dot2.s-error { background: var(--d1-bad, #dc2626); }
.actstatus { text-transform: uppercase; font-size: var(--fs-xs, 11px); font-weight: 700; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.acttime { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 650; font-size: var(--fs-sm, 12px); word-break: break-all; }
.empty { padding: 16px; text-align: center; color: var(--d1-dim, var(--theme--foreground-subdued)); font-size: var(--fs-md, 13px); }

@media (max-width: 900px) {
	.row.two { grid-template-columns: 1fr; }
}
</style>
