<script setup lang="ts">
// Version + changelog + the update controls. Electron-only for the update controls: the
// browser-served /app/ build has no window.forceApp and auto-update has no meaning there.
import { onMounted, ref } from 'vue';
import { CHANGELOG } from '../changelog';

type UpdateStatus =
	| { state: 'idle' }
	| { state: 'checking' }
	| { state: 'available'; version: string }
	| { state: 'not-available' }
	| { state: 'downloading'; percent: number }
	| { state: 'downloaded'; version: string }
	| { state: 'installing'; version: string }
	| { state: 'error'; message: string };

const isElectron = !!window.forceApp;
const appVersion = ref('');
const packaged = ref(false);
const updateStatus = ref<UpdateStatus>({ state: 'idle' });
const checking = ref(false);
const installing = ref(false);
const installNotice = ref('');

async function checkForUpdates() {
	if (!window.forceApp) return;
	checking.value = true;
	try {
		const res = await window.forceApp.checkForUpdates();
		if (!res.ok) updateStatus.value = { state: 'error', message: res.reason || 'could not check for updates' };
	} finally {
		checking.value = false;
	}
}

// Same "don't interrupt a recording" guard the automatic prompt applies, so there is no way to
// force a restart mid-cut whether the operator reacts to the dialog or comes here instead.
async function installNow() {
	if (!window.forceApp) return;
	installing.value = true;
	installNotice.value = '';
	try {
		const res = await window.forceApp.installUpdate();
		if (!res.ok) installNotice.value = res.reason || 'could not install right now';
	} finally {
		installing.value = false;
	}
}

onMounted(async () => {
	if (!window.forceApp) return;
	const info = await window.forceApp.getUpdateInfo();
	appVersion.value = info.version;
	packaged.value = info.packaged;
	updateStatus.value = info.status;
	window.forceApp.onUpdateStatus((s) => { updateStatus.value = s; });
});
</script>

<template>
	<div class="about">
		<h2>Version</h2>
		<p class="lead">
			<template v-if="isElectron">Force App {{ appVersion || '…' }}<span v-if="!packaged"> (dev build — auto-update is disabled)</span></template>
			<template v-else>Browser build — version and updates are managed by the desktop app.</template>
		</p>

		<template v-if="isElectron">
			<div class="actions">
				<button class="btn" :disabled="!packaged || checking || updateStatus.state === 'checking' || updateStatus.state === 'downloading'"
					@click="checkForUpdates">
					<span class="material-symbols-rounded">refresh</span>
					{{ updateStatus.state === 'checking' ? 'Checking…' : 'Check for updates' }}
				</button>
				<button v-if="updateStatus.state === 'downloaded'" class="btn primary" :disabled="installing" @click="installNow">
					<span class="material-symbols-rounded">restart_alt</span> Restart and install
				</button>
			</div>
			<p v-if="updateStatus.state === 'not-available'" class="hint">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">check_circle</span> You're up to date.
			</p>
			<p v-else-if="updateStatus.state === 'available'" class="hint">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">cloud_download</span> Version {{ updateStatus.version }} found — downloading…
			</p>
			<p v-else-if="updateStatus.state === 'downloading'" class="hint">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">cloud_download</span> Downloading… {{ updateStatus.percent }}%
			</p>
			<p v-else-if="updateStatus.state === 'downloaded'" class="hint">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">task_alt</span> Version {{ updateStatus.version }} downloaded — install whenever you're ready.
			</p>
			<p v-else-if="updateStatus.state === 'installing'" class="hint">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">hourglass_top</span> Installing version {{ updateStatus.version }}…
			</p>
			<p v-else-if="updateStatus.state === 'error'" class="err">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">error</span> {{ updateStatus.message }}
			</p>
			<p v-if="installNotice" class="err">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">error</span> {{ installNotice }}
			</p>
		</template>

		<!-- The window is about to close and silently reinstall — without this the app just vanishes
			 the instant "Restart and install" is clicked, which reads as a crash. The main process also
			 fires an OS notification (covers the case where the update dialog is answered from outside
			 this page), but this overlay is the clearer signal when the operator IS looking at this
			 page. Held up for ~800ms by the main process before the process actually quits, so this has
			 time to paint. -->
		<div v-if="isElectron && updateStatus.state === 'installing'" class="install-overlay">
			<span class="material-symbols-rounded spin">autorenew</span>
			<p>Installing version {{ updateStatus.version }}…</p>
			<p class="sub">The app will close and reopen automatically — this takes a few seconds.</p>
		</div>

		<div class="changelog-head mt">
			<h2>What's new</h2>
			<!-- #43 -->
			<a href="https://github.com/dpremoli/D1-Database/releases" target="_blank" rel="noopener" class="releases-link">
				<span class="material-symbols-rounded">open_in_new</span> View all releases on GitHub
			</a>
		</div>
		<!-- #44: this list only ever grows (one entry per release, never pruned), so without its own
			 scroll area it eventually pushes the whole Settings window's height along with it. -->
		<div class="changelog">
			<div v-for="c in CHANGELOG" :key="c.version" class="entry" :class="{ current: isElectron && c.version === appVersion }">
				<div class="entry-head">
					<span class="entry-version">v{{ c.version }}</span>
					<span v-if="isElectron && c.version === appVersion" class="badge current-badge">running now</span>
					<span class="entry-date">{{ c.date }}</span>
				</div>
				<ul>
					<li v-for="n in c.notes" :key="n">{{ n }}</li>
				</ul>
			</div>
		</div>
	</div>
</template>

<style scoped>
.about { max-width: 640px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.mt { margin-top: 32px; }
.lead { margin: 0 0 12px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.hint { display: flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-dim); margin-top: 4px; }
.err { display: flex; align-items: center; gap: 5px; color: var(--danger); font-size: var(--fs-sm); margin: 4px 0 0; }
.actions { display: flex; gap: 10px; margin-top: 6px; }

.install-overlay { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column;
	align-items: center; justify-content: center; gap: 6px; background: rgba(0,0,0,0.75); color: #fff; text-align: center; }
.install-overlay .material-symbols-rounded { font-size: var(--icon-2xl); margin-bottom: 6px; }
.install-overlay p { margin: 0; font-size: var(--fs-lg); }
.install-overlay .sub { font-size: var(--fs-sm); color: rgba(255,255,255,0.7); }

.changelog-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.changelog-head h2 { margin: 0; }
.releases-link { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 600; color: var(--accent); text-decoration: none; }
.releases-link:hover { text-decoration: underline; }
.releases-link .material-symbols-rounded { font-size: var(--icon-xs); }
/* #44: capped so a long, ever-growing history scrolls in place instead of pushing the whole
   Settings window taller — max-height is a viewport fraction (not a fixed px) so it still leaves
   room to see other page content above it on a shorter window. */
.changelog { display: flex; flex-direction: column; gap: 14px; max-height: 55vh; overflow-y: auto; padding-right: 4px; }
.entry { padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.entry.current { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.entry-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.entry-version { font-family: var(--mono); font-size: var(--fs-md); font-weight: 700; color: var(--text); }
.entry-date { font-size: var(--fs-xs); color: var(--text-dim); margin-left: auto; }
.current-badge { font-size: var(--fs-xs); font-weight: 700; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent-ink); background: var(--accent); }
.entry ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.entry li { font-size: var(--fs-md); color: var(--text-dim); line-height: 1.45; }
</style>
