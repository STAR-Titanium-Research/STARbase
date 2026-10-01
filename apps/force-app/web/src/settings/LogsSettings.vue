<script setup lang="ts">
// Backend log viewer. The desktop app runs the recorder as a hidden sidecar and keeps only a
// short in-memory stderr tail for crash reports, so until now the log file was unreadable without
// digging through AppData — while the crash dialog told the operator to "see logs for details".
// Served over HTTP rather than through the Electron bridge so this works identically in the
// browser-served /app/ build, where window.forceApp is undefined.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { getConfig } from '../config';

interface LogRecord { ts: string; level: string; logger: string; message: string; }

const base = () => getConfig().recorderUrl;

const records = ref<LogRecord[]>([]);
const loggers = ref<string[]>([]);
const logPath = ref('');
const available = ref(true);
const loading = ref(false);
const error = ref('');
const copied = ref(false);

const LEVELS = ['', 'DEBUG', 'INFO', 'WARNING', 'ERROR'] as const;
const level = ref<string>('');
const search = ref('');
const limit = ref(500);
const autoRefresh = ref(false);
const follow = ref(true);

// Runtime verbosity, separate from the `level` filter above (that filters what's already shown;
// this controls what the backend writes in the first place, e.g. for reproducing an intermittent
// issue). Not persisted server-side — reverts to INFO on the next backend launch.
const RUNTIME_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as const;
const runtimeLevel = ref('');
const settingLevel = ref(false);

let runtimeLevelRetryT: ReturnType<typeof setTimeout> | null = null;

async function loadRuntimeLevel() {
	try {
		const res = await fetch(`${base()}/logs/level`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		runtimeLevel.value = data.level || '';
	} catch {
		// Backend not reachable yet (e.g. sidecar still starting) — retry instead of leaving the
		// control permanently disabled once it does come up.
		runtimeLevelRetryT = setTimeout(loadRuntimeLevel, 3000);
	}
}

async function setRuntimeLevel(lvl: string) {
	settingLevel.value = true;
	try {
		const body = new URLSearchParams({ level: lvl });
		const res = await fetch(`${base()}/logs/level`, { method: 'POST', body });
		if (res.ok) runtimeLevel.value = lvl;
	} finally {
		settingLevel.value = false;
	}
}

const listEl = ref<HTMLElement | null>(null);

async function load() {
	loading.value = true;
	error.value = '';
	try {
		const params = new URLSearchParams({ limit: String(limit.value) });
		if (level.value) params.set('level', level.value);
		if (search.value.trim()) params.set('q', search.value.trim());
		const res = await fetch(`${base()}/logs?${params}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		records.value = data.records || [];
		loggers.value = data.loggers || [];
		logPath.value = data.path || '';
		available.value = !!data.available;
		if (follow.value) {
			// Wait a tick so the list has actually rendered the new rows before scrolling.
			requestAnimationFrame(() => {
				if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
			});
		}
	} catch (e: any) {
		error.value = /failed to fetch|load failed|networkerror/i.test(e?.message || '')
			? "can't reach the recording backend — is it running?"
			: e?.message || 'failed to load logs';
	} finally {
		loading.value = false;
	}
}

// Re-query the backend on filter changes (filtering happens server-side against the whole rotated
// history, so a client-side filter would only ever search the page already fetched).
let debounceT: ReturnType<typeof setTimeout> | null = null;
watch([level, limit], () => load());
watch(search, () => {
	if (debounceT) clearTimeout(debounceT);
	debounceT = setTimeout(load, 300);
});

// Settings panes are v-if-destroyed on tab switch, so this timer must be cleared on unmount or it
// keeps polling the backend for the life of the session.
let pollT: ReturnType<typeof setInterval> | null = null;
watch(autoRefresh, (on) => {
	if (pollT) { clearInterval(pollT); pollT = null; }
	if (on) pollT = setInterval(load, 3000);
});

onMounted(load);
onMounted(loadRuntimeLevel);
onUnmounted(() => {
	if (pollT) clearInterval(pollT);
	if (debounceT) clearTimeout(debounceT);
	if (runtimeLevelRetryT) clearTimeout(runtimeLevelRetryT);
});

function copyAll() {
	const text = records.value
		.map((r) => `${r.ts} ${r.level} ${r.logger}: ${r.message}`)
		.join('\n');
	navigator.clipboard.writeText(text);
	copied.value = true;
	setTimeout(() => (copied.value = false), 2000);
}

function downloadLog() {
	// A plain link, not fetch+blob: the file can be large and this lets the browser stream it.
	window.open(`${base()}/logs/download`, '_blank');
}

const counts = computed(() => {
	const c = { WARNING: 0, ERROR: 0, CRITICAL: 0 } as Record<string, number>;
	for (const r of records.value) if (r.level in c) c[r.level]++;
	return c;
});
const problems = computed(() => counts.value.WARNING + counts.value.ERROR + counts.value.CRITICAL);
</script>

<template>
	<div class="logs">
		<h2>Logs</h2>
		<p class="lead">
			Recent activity from the recording backend — start/stop timing, finalize duration, hardware
			warnings and errors. Useful when a recording behaves unexpectedly, and the first thing to
			attach to a bug report.
		</p>

		<div v-if="!available" class="warnbox">
			<span class="material-symbols-rounded">warning</span>
			<div>
				<b>No log file</b>
				<span>The backend could not write to its log directory and is logging to the console only.
					Recording is unaffected. The Connectivity tab's doctor can help identify why.</span>
			</div>
		</div>

		<div class="toolbar">
			<label class="tb-field">
				<span>Level</span>
				<select v-model="level">
					<option v-for="l in LEVELS" :key="l" :value="l">{{ l || 'All' }}</option>
				</select>
			</label>
			<label class="tb-field grow">
				<span>Search</span>
				<input v-model="search" placeholder="filter by message or module…" spellcheck="false" />
			</label>
			<label class="tb-field">
				<span>Lines</span>
				<select v-model.number="limit">
					<option :value="200">200</option>
					<option :value="500">500</option>
					<option :value="2000">2000</option>
					<option :value="5000">5000</option>
				</select>
			</label>
			<label class="tb-field" title="How much detail the backend writes to the log right now — separate from the filter above, and not remembered across restarts.">
				<span>Backend verbosity</span>
				<select :value="runtimeLevel" :disabled="settingLevel || !runtimeLevel" @change="setRuntimeLevel(($event.target as HTMLSelectElement).value)">
					<option v-for="l in RUNTIME_LEVELS" :key="l" :value="l">{{ l }}</option>
				</select>
			</label>
		</div>

		<div class="toolbar2">
			<button class="btn" :disabled="loading" @click="load">
				<span class="material-symbols-rounded">{{ loading ? 'hourglass_top' : 'refresh' }}</span>
				{{ loading ? 'Loading…' : 'Refresh' }}
			</button>
			<label class="chk"><input type="checkbox" v-model="autoRefresh" /> Auto-refresh</label>
			<label class="chk"><input type="checkbox" v-model="follow" /> Follow latest</label>
			<div class="spacer"></div>
			<span v-if="problems" class="tally" :class="{ err: counts.ERROR || counts.CRITICAL }">
				{{ counts.ERROR + counts.CRITICAL }} error<span v-if="counts.ERROR + counts.CRITICAL !== 1">s</span>,
				{{ counts.WARNING }} warning<span v-if="counts.WARNING !== 1">s</span>
			</span>
			<button class="btn" :disabled="!records.length" @click="copyAll">
				<span class="material-symbols-rounded">{{ copied ? 'check' : 'content_copy' }}</span>
				{{ copied ? 'Copied' : 'Copy' }}
			</button>
			<button class="btn" :disabled="!available" @click="downloadLog">
				<span class="material-symbols-rounded">download</span>Download
			</button>
		</div>

		<p v-if="error" class="err">{{ error }}</p>

		<div ref="listEl" class="loglist">
			<div v-if="!records.length && !loading" class="empty">
				{{ search || level ? 'No matching log entries.' : 'No log entries yet.' }}
			</div>
			<div v-for="(r, i) in records" :key="i" class="row" :class="r.level.toLowerCase()">
				<span class="ts">{{ r.ts.slice(11) || '—' }}</span>
				<span class="lvl">{{ r.level }}</span>
				<span class="mod">{{ r.logger.replace(/^force_app\./, '') }}</span>
				<span class="msg">{{ r.message }}</span>
			</div>
		</div>

		<p v-if="logPath" class="hint path">{{ logPath }}</p>
	</div>
</template>

<style scoped>
/* Wider than the other panes: log lines are long and wrapping them hurts scanability. The parent
   .body caps at 1000px, so this fills whatever the tab rail leaves. */
.logs { max-width: 100%; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.lead { margin: 0 0 18px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); }
.path { margin-top: 8px; font-family: var(--mono); word-break: break-all; }
.err { color: var(--danger); font-size: var(--fs-sm); }
.warnbox { display: flex; gap: 10px; padding: 11px 13px; margin-bottom: 14px; font-size: var(--fs-md);
	background: color-mix(in srgb, var(--warn) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: 9px; }
.warnbox .material-symbols-rounded { font-size: var(--icon-lg); color: var(--warn); }
.warnbox div { display: flex; flex-direction: column; gap: 2px; }
.warnbox b { font-size: var(--fs-md); }
.warnbox span { color: var(--text-dim); line-height: 1.45; }

.toolbar { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.toolbar .tb-field { min-width: 0; }
.toolbar .tb-field.grow { flex: 1 1 160px; }
.toolbar .tb-field input, .toolbar .tb-field select { max-width: 100%; }
.toolbar2 { display: flex; gap: 10px; align-items: center; margin: 10px 0 8px; flex-wrap: wrap; }
.tb-field { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-sm); color: var(--text-dim); margin: 0; }
.tb-field.grow { flex: 1; min-width: 160px; }
.tb-field select, .tb-field input { padding: 7px 9px; font: inherit; font-size: var(--fs-md); color: var(--text);
	background: var(--surface); border: 1px solid var(--border); border-radius: 7px; outline: none; }
.tb-field select:focus, .tb-field input:focus { border-color: var(--accent); }
.spacer { flex: 1; }
.chk { display: flex; align-items: center; gap: 6px; font-size: var(--fs-md); color: var(--text); cursor: pointer; }
.chk input { accent-color: var(--accent); }
.tally { font-size: var(--fs-sm); font-weight: 600; color: var(--warn); }
.tally.err { color: var(--danger); }

.loglist { height: 52vh; min-height: 260px; overflow: auto; background: var(--bg);
	border: 1px solid var(--border); border-radius: 9px; padding: 6px 0; }
/* #45: the ts column was 62px, too narrow for "HH:MM:SS,mmm" (12 monospace chars, ~83px) at this
   font-size -- it overflowed into the level column next to it, reading as an overlap. */
.row { display: grid; grid-template-columns: 86px 62px 78px 1fr; gap: 8px; padding: 2px 11px;
	font-family: var(--mono); font-size: var(--fs-sm); line-height: 1.5; align-items: baseline; }
.row:hover { background: var(--surface); }
.ts { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.lvl { font-weight: 700; color: var(--text-dim); }
.mod { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; }
/* Preserve newlines so a captured traceback stays readable as a block. */
.msg { color: var(--text); white-space: pre-wrap; word-break: break-word; }
.row.warning .lvl { color: var(--warn); }
.row.error .lvl, .row.critical .lvl { color: var(--danger); }
.row.error, .row.critical { background: rgba(239,68,68,0.06); }
.row.debug { opacity: 0.65; }
.empty { padding: 26px; text-align: center; color: var(--text-dim); font-size: var(--fs-md); }
</style>
