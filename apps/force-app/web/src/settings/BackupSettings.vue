<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getConfig } from '../config';
import { confirmAction } from '../ui/confirm';

interface BackupConfig {
	enabled: boolean;
	server_url: string;
	retention_hours: number;
	server_status?: { reachable: boolean; sessions?: number; disk_free_gb?: number; retention_hours?: number; error?: string };
}
interface RemoteSession {
	id: string;
	state: string;
	raw_size_mb: number;
	duration_sec?: number;
	started_iso?: string;
	n_rows?: number;
	rate?: number;
}

const base = () => getConfig().recorderUrl;
const cfg = ref<BackupConfig>({ enabled: false, server_url: '', retention_hours: 12 });
const loading = ref(false);
const saved = ref(false);
const error = ref('');
const sessions = ref<RemoteSession[]>([]);
const sessionsLoading = ref(false);
const restoreBusy = ref<Record<string, boolean>>({});

async function loadConfig() {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch(`${base()}/backup/config`);
		if (res.ok) Object.assign(cfg.value, await res.json());
	} catch (e: any) {
		error.value = e?.message || 'failed';
	} finally {
		loading.value = false;
	}
}

async function saveConfig() {
	error.value = '';
	try {
		const res = await fetch(`${base()}/backup/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				enabled: cfg.value.enabled,
				server_url: cfg.value.server_url,
				retention_hours: cfg.value.retention_hours,
			}),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		Object.assign(cfg.value, await res.json());
		saved.value = true;
		setTimeout(() => (saved.value = false), 2000);
	} catch (e: any) {
		error.value = e?.message || 'save failed';
	}
}

async function testConnection() {
	error.value = '';
	loading.value = true;
	try {
		const res = await fetch(`${base()}/backup/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ server_url: cfg.value.server_url }),
		});
		if (res.ok) {
			const data = await res.json();
			Object.assign(cfg.value, data);
			await loadConfig();
		}
	} catch (e: any) {
		error.value = e?.message || 'test failed';
	} finally {
		loading.value = false;
	}
}

async function loadSessions() {
	sessionsLoading.value = true;
	try {
		const res = await fetch(`${base()}/backup/remote-sessions`);
		if (res.ok) {
			const data = await res.json();
			sessions.value = data.sessions || [];
		}
	} catch { /* ignore */ } finally {
		sessionsLoading.value = false;
	}
}

async function restoreSession(id: string) {
	const ok = await confirmAction({
		title: 'Restore this backup?',
		message: `Backup ${id} will be downloaded and finalized on this machine.`,
		detail: 'Downloading raw data can take a while and use significant disk space.',
		confirmLabel: 'Restore',
	});
	if (!ok) return;
	restoreBusy.value[id] = true;
	try {
		const res = await fetch(`${base()}/backup/restore/${id}`, { method: 'POST' });
		if (!res.ok) {
			const text = await res.text();
			throw new Error(text.slice(0, 200));
		}
		sessions.value = sessions.value.filter((s) => s.id !== id);
		alert('Recording restored successfully.');
	} catch (e: any) {
		alert(`Restore failed: ${e?.message || e}`);
	} finally {
		delete restoreBusy.value[id];
	}
}

onMounted(() => { loadConfig(); });
</script>

<template>
	<div class="backup">
		<h2>Remote Live Backup</h2>
		<p class="lead">Stream recording data to a remote backup server during acquisition. If the local recording is lost, it can be recovered from the server.</p>

		<label class="toggle-row">
			<input type="checkbox" v-model="cfg.enabled" />
			<span>Enable live backup</span>
		</label>

		<label class="field">
			<span class="lbl">Backup server URL</span>
			<input v-model="cfg.server_url" placeholder="https://d1-server.tail54eeb6.ts.net/backup-ingest" spellcheck="false" />
			<span class="hint">
				The remote backup service endpoint. On the lab server it runs behind the shared proxy at
				<code>/backup-ingest</code>; a directly-run server on its own port (e.g.
				<code>http://host:8210</code>) works too.
			</span>
		</label>

		<label class="field">
			<span class="lbl">Retention (hours)</span>
			<input type="number" v-model.number="cfg.retention_hours" min="1" max="168" />
			<span class="hint">How long the server keeps backup recordings before purging.</span>
		</label>

		<!-- Server status -->
		<div v-if="cfg.server_status" class="server-status" :class="{ ok: cfg.server_status.reachable, fail: !cfg.server_status.reachable }">
			<span class="material-symbols-rounded">{{ cfg.server_status.reachable ? 'check_circle' : 'cancel' }}</span>
			<div class="ss-info">
				<span class="ss-label">{{ cfg.server_status.reachable ? 'Server reachable' : 'Server unreachable' }}</span>
				<span v-if="cfg.server_status.reachable && cfg.server_status.disk_free_gb !== undefined" class="ss-detail">
					{{ cfg.server_status.sessions }} backups · {{ cfg.server_status.disk_free_gb }} GB free · {{ cfg.server_status.retention_hours }}h retention
				</span>
				<span v-if="cfg.server_status.error" class="ss-detail err">{{ cfg.server_status.error }}</span>
			</div>
		</div>

		<div v-if="error" class="err-msg">{{ error }}</div>

		<div class="actions">
			<button class="btn primary" @click="saveConfig">{{ saved ? 'Saved ✓' : 'Save' }}</button>
			<button class="btn" @click="testConnection" :disabled="loading || !cfg.server_url">
				{{ loading ? 'Testing…' : 'Test connection' }}
			</button>
		</div>

		<!-- Remote sessions -->
		<h3 class="mt">Remote backups</h3>
		<p class="lead">Recordings stored on the backup server. Restore a backup if the local recording was lost.</p>
		<button class="btn" :disabled="sessionsLoading || !cfg.server_url" @click="loadSessions">
			<span class="material-symbols-rounded" style="font-size: var(--icon-sm)">{{ sessionsLoading ? 'hourglass_top' : 'cloud_download' }}</span>
			{{ sessionsLoading ? 'Loading…' : 'Fetch remote backups' }}
		</button>

		<div v-if="sessions.length" class="session-list">
			<div v-for="s in sessions" :key="s.id" class="rs-item">
				<div class="rs-info">
					<span class="rs-id">{{ s.id }}</span>
					<span class="rs-detail">
						<span v-if="s.duration_sec">{{ s.duration_sec.toFixed(1) }}s</span>
						<span v-if="s.n_rows"> · {{ s.n_rows.toLocaleString() }} samples</span>
						<span> · {{ s.raw_size_mb }} MB</span>
						<span class="rs-state" :class="s.state">{{ s.state }}</span>
					</span>
					<span v-if="s.started_iso" class="rs-detail dim">{{ s.started_iso }}</span>
				</div>
				<button class="btn sm success" :disabled="!!restoreBusy[s.id]" @click="restoreSession(s.id)">
					<span class="material-symbols-rounded">cloud_download</span>{{ restoreBusy[s.id] ? 'Restoring…' : 'Restore' }}
				</button>
			</div>
		</div>
		<p v-else-if="!sessionsLoading && sessions.length === 0 && cfg.server_url" class="hint" style="margin-top:8px">No remote backups found.</p>
	</div>
</template>

<style scoped>
.backup { max-width: 620px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
h3 { margin: 0 0 4px; font-size: var(--fs-lg); }
.lead { margin: 0 0 14px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; font-size: var(--fs-md); font-weight: 600; color: var(--text); cursor: pointer; }
.toggle-row input { width: 16px; height: 16px; accent-color: var(--accent); }
.field { display: block; margin-bottom: 14px; }
.lbl { display: block; font-size: var(--fs-md); color: var(--text); margin-bottom: 5px; }
input { display: block; width: 100%; padding: 9px 11px; font-size: var(--fs-md); font-family: var(--mono); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; outline: none; box-sizing: border-box; }
input:focus { border-color: var(--accent); }
input[type="number"] { max-width: 120px; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); margin-top: 4px; }
.err-msg { color: var(--danger); font-size: var(--fs-sm); margin: 6px 0; }
.actions { display: flex; gap: 10px; margin-top: 10px; }
.mt { margin-top: 28px; }

.server-status { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 9px; margin-bottom: 10px; }
.server-status.ok { background: color-mix(in srgb, var(--ok) 8%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 20%, transparent); }
.server-status.fail { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); }
.server-status .material-symbols-rounded { font-size: var(--icon-lg); }
.server-status.ok .material-symbols-rounded { color: var(--ok); }
.server-status.fail .material-symbols-rounded { color: var(--danger); }
.ss-info { display: flex; flex-direction: column; }
.ss-label { font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.ss-detail { font-size: var(--fs-sm); color: var(--text-dim); }
.ss-detail.err { color: var(--danger); }

.session-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.rs-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; }
.rs-info { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.rs-id { font-size: var(--fs-sm); font-weight: 600; font-family: var(--mono); color: var(--text); }
.rs-detail { font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.rs-detail.dim { opacity: 0.7; }
.rs-state { display: inline-block; margin-left: 6px; font-size: var(--fs-xs); font-weight: 700; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; }
.rs-state.complete { color: #15803d; background: rgba(34,197,94,0.15); }
.rs-state.streaming { color: #d97706; background: color-mix(in srgb, var(--warn) 15%, transparent); }
</style>
