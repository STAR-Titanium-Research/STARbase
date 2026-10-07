<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getConfig } from '../config';
import { theme, applyTheme } from '../theme';

// Named explicitly (not left to filename inference) so SettingsPage.vue's <keep-alive
// include="GeneralSettings"> can target this component reliably regardless of build config —
// see the comment there for why this tab specifically is cached across tab switches.
defineOptions({ name: 'GeneralSettings' });

// ---- Storage location ----
interface DriveInfo {
	path: string; letter?: string; label?: string; type: string; is_ssd: boolean | null;
	less_reliable?: boolean; reliability_note?: string | null;
	total_gb: number; free_gb: number; used_pct: number;
}
const drives = ref<DriveInfo[]>([]);
const currentStorage = ref<{ captures_root: string; free_gb: number; total_gb: number; used_pct: number } | null>(null);
const storageSaved = ref(false);
const storageLoading = ref(false);
const storageError = ref('');

// FastAPI's HTTPException body is {"detail": "..."} — showing that instead of a bare status code
// is the difference between "cannot create directory: [WinError 2] ..." and "HTTP 400", the
// latter of which sends every failure back to us to reproduce from scratch.
async function errorDetail(res: Response, fallback: string): Promise<string> {
	try {
		const body = await res.json();
		if (typeof body?.detail === 'string') return body.detail;
	} catch { /* body wasn't JSON */ }
	return `${fallback} (HTTP ${res.status})`;
}

async function loadDrives() {
	storageLoading.value = true;
	storageError.value = '';
	try {
		const base = getConfig().recorderUrl;
		const res = await fetch(`${base}/storage/drives`);
		if (!res.ok) throw new Error(await errorDetail(res, 'failed to load drives'));
		const data = await res.json();
		drives.value = data.drives || [];
		currentStorage.value = data.current || null;
	} catch (e: any) {
		storageError.value = e?.message || 'failed to load drives';
	} finally {
		storageLoading.value = false;
	}
}

// #101: recordings can go in any folder, not only <drive>\force-app-captures. The desktop app
// gets the native folder picker; the browser build cannot open one, so it takes a typed path.
// The backend checks either (writable, and not while a recording is running or saving).
const canPickFolder = typeof window.forceApp?.pickFolder === 'function';
const typedPath = ref('');
// Captures stay in the folder they were recorded to, and Local Captures lists only the current
// one, so after a change say where the earlier ones are rather than let them look deleted.
const previousRoot = ref('');

const samePath = (a: string, b: string) =>
	a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

function selectDrive(drive: DriveInfo) {
	return setCapturesRoot(drive.path + 'force-app-captures');
}

async function pickFolder() {
	const chosen = await window.forceApp?.pickFolder(currentStorage.value?.captures_root);
	if (chosen) await setCapturesRoot(chosen);
}

function useTypedPath() {
	const p = typedPath.value.trim();
	if (p) void setCapturesRoot(p);
}

async function setCapturesRoot(path: string) {
	const before = currentStorage.value?.captures_root || '';
	storageError.value = '';
	try {
		const base = getConfig().recorderUrl;
		const res = await fetch(`${base}/storage/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ captures_root: path }),
		});
		if (!res.ok) throw new Error(await errorDetail(res, 'failed to set storage'));
		const data = await res.json();
		currentStorage.value = data;
		if (before && !samePath(before, data.captures_root)) {
			// Switching back to the earlier folder clears the note instead of pointing at the new one.
			previousRoot.value = previousRoot.value && samePath(previousRoot.value, data.captures_root) ? '' : before;
		}
		typedPath.value = '';
		// The drive can apply to the running backend but fail to persist (an unwritable config
		// location). Saying "saved" then reverting on restart is the failure this replaces, so the
		// warning is shown instead of the tick and is not auto-dismissed.
		if (data.persisted === false && data.warning) {
			storageError.value = data.warning;
		} else {
			storageSaved.value = true;
			setTimeout(() => (storageSaved.value = false), 2000);
		}
	} catch (e: any) {
		storageError.value = e?.message || 'failed to set storage';
	}
}

function driveDisplayName(d: DriveInfo) {
	const parts: string[] = [];
	if (d.letter) parts.push(`${d.letter}:`);
	if (d.label) parts.push(d.label);
	if (!parts.length) parts.push(d.path);
	return parts.join(' ');
}

function isCurrentDrive(d: DriveInfo) {
	if (!currentStorage.value) return false;
	const root = currentStorage.value.captures_root.toUpperCase();
	return d.letter ? root.startsWith(d.letter.toUpperCase() + ':') : root.startsWith(d.path.toUpperCase());
}

onMounted(() => { loadDrives(); });
</script>

<template>
	<div class="general">
		<h2>Appearance</h2>
		<div class="theme-toggle segmode lg">
			<button class="segbtn" :class="{ on: theme === 'dark' }" @click="applyTheme('dark')"><span class="material-symbols-rounded">dark_mode</span> Dark</button>
			<button class="segbtn" :class="{ on: theme === 'light' }" @click="applyTheme('light')"><span class="material-symbols-rounded">light_mode</span> Light</button>
		</div>

		<h2 class="mt">Recording storage</h2>
		<p class="lead">Choose where recordings are saved. SSD drives are recommended for high-frequency acquisition. Picking a drive uses a <code>force-app-captures</code> folder on it; you can also choose any folder.</p>

		<div v-if="storageLoading" class="hint">Loading drives…</div>
		<div v-else-if="storageError" class="err">{{ storageError }}</div>

		<div class="drive-list">
			<button v-for="d in drives" :key="d.path" class="drive" :class="{ active: isCurrentDrive(d), ssd: d.is_ssd, low: d.free_gb < 10, caution: d.less_reliable }" @click="selectDrive(d)">
				<span class="material-symbols-rounded drive-icon">{{ d.less_reliable ? 'cloud' : d.is_ssd ? 'flash_on' : 'hard_drive' }}</span>
				<div class="drive-info">
					<span class="drive-name">
						{{ driveDisplayName(d) }}
						<span v-if="d.is_ssd" class="badge ssd-badge">SSD</span>
						<span v-else-if="d.is_ssd === false && !d.less_reliable" class="badge hdd-badge">HDD</span>
						<span v-if="d.less_reliable" class="badge caution-badge" :title="d.reliability_note || undefined">Not recommended</span>
					</span>
					<span class="drive-detail">{{ d.free_gb.toFixed(1) }} GB free of {{ d.total_gb.toFixed(0) }} GB</span>
					<span v-if="d.reliability_note" class="drive-caution-note">{{ d.reliability_note }}</span>
				</div>
				<div class="drive-bar-wrap">
					<div class="drive-bar" :class="{ warn: d.used_pct > 85, crit: d.used_pct > 95 }" :style="{ width: d.used_pct + '%' }"></div>
				</div>
				<span v-if="isCurrentDrive(d)" class="material-symbols-rounded drive-check">check_circle</span>
			</button>
		</div>

		<div class="custom-folder">
			<button v-if="canPickFolder" class="btn" @click="pickFolder">
				<span class="material-symbols-rounded">folder_open</span> Choose folder…
			</button>
			<form v-else class="typed-path" @submit.prevent="useTypedPath">
				<input v-model="typedPath" spellcheck="false" placeholder="Or type a folder, e.g. D:\Recordings" aria-label="Recording folder" />
				<button class="btn" type="submit" :disabled="!typedPath.trim()">Use folder</button>
			</form>
		</div>

		<p v-if="currentStorage" class="hint storage-path">
			<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">folder</span>
			{{ currentStorage.captures_root }}
			<span v-if="storageSaved" class="saved-tag">Saved ✓</span>
		</p>
		<p v-if="currentStorage && currentStorage.free_gb < 5" class="err">
			<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">warning</span>
			Low disk space! Only {{ currentStorage.free_gb.toFixed(1) }} GB remaining. Recordings may fail.
		</p>
		<p v-if="previousRoot" class="hint moved-note">
			<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">info</span>
			<span>Recordings made before this change stay in <code>{{ previousRoot }}</code>. Local Captures lists only the current folder, so switch back to see or upload them.</span>
		</p>
	</div>
</template>

<style scoped>
.general { max-width: 620px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.lead { margin: 0 0 18px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.lead code { font-family: var(--mono); font-size: var(--fs-sm); padding: 1px 5px; background: var(--surface); border-radius: 4px; }
.hint { display: flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-dim); margin-top: 4px; }
.err { display: flex; align-items: center; gap: 5px; color: var(--danger); font-size: var(--fs-sm); margin: 4px 0 0; }
.mt { margin-top: 32px; }
.theme-toggle { margin-bottom: 20px; max-width: 100%; }

/* Storage drives */
.drive-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.drive { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--surface); border: 2px solid transparent; border-radius: 10px; cursor: pointer; text-align: left; }
.drive:hover { border-color: var(--border); background: var(--surface-2); }
.drive.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.drive.low:not(.active) { border-color: var(--warn); }
.drive-icon { font-size: var(--icon-xl); color: var(--text-dim); }
.drive.ssd .drive-icon { color: #22c55e; }
.drive-info { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.drive-name { font-size: var(--fs-md); font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.drive-detail { font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.badge { font-size: var(--fs-xs); font-weight: 700; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
.ssd-badge { color: #15803d; background: rgba(34,197,94,0.15); }
.hdd-badge { color: var(--text-dim); background: var(--surface-2); }
.caution-badge { color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); cursor: help; }
.drive.caution:not(.active) { border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
.drive.caution .drive-icon { color: #b45309; }
.drive-caution-note { font-size: var(--fs-xs); color: #b45309; line-height: 1.4; margin-top: 1px; }
.drive-bar-wrap { width: 80px; height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
.drive-bar { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s; }
.drive-bar.warn { background: #fbbf24; }
.drive-bar.crit { background: #ef4444; }
.drive-check { font-size: var(--icon-md); color: var(--accent); }
.storage-path { font-family: var(--mono); font-size: var(--fs-xs); word-break: break-all; }
.saved-tag { font-size: var(--fs-xs); font-weight: 700; color: var(--ok); margin-left: 6px; }
.custom-folder { margin: 4px 0 8px; }
.typed-path { display: flex; gap: 6px; }
.typed-path input { flex: 1; min-width: 0; padding: 7px 10px; font-size: var(--fs-sm); font-family: var(--mono); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; outline: none; }
.typed-path input:focus { border-color: var(--accent); }
.moved-note { align-items: flex-start; line-height: 1.45; }
.moved-note code { font-family: var(--mono); font-size: var(--fs-xs); word-break: break-all; }

</style>
