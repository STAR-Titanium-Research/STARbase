<script setup lang="ts">
// Version + changelog + the update controls. Electron-only for the update controls: the
// browser-served /app/ build has no window.forceApp and auto-update has no meaning there.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { CHANGELOG } from '../changelog';
import { groupNotes } from '../changelogGroups';
import type { UpdateStatus } from '../electronBridge';
import { getEligibility } from '../rigtest/rigTestApi';
import { ThinkingOrb } from '@d1/force-plotting';
import { closedNotifyBridge, closedNotifyWarning, loadClosedNotify, toggleClosedNotifyBox } from './closedNotify';

// The changelog is static, so group each entry's notes once, not on every render.
const ENTRIES = CHANGELOG.map((c) => ({ ...c, groups: groupNotes(c.notes) }));

const isElectron = !!window.forceApp;
const appVersion = ref('');
const packaged = ref(false);
const updateStatus = ref<UpdateStatus>({ state: 'idle' });
const checking = ref(false);
const installing = ref(false);
const installNotice = ref('');

// #197: tell me about updates while the app is closed (the shell's Windows scheduled task).
const closedBridge = closedNotifyBridge();
const closedSupported = ref(false);
const closedEnabled = ref(true);
const closedActive = ref(true);   // the scheduled task really exists (see closedNotify.ts)
const closedBusy = ref(false);
const closedError = ref('');
async function toggleClosedNotify(box: HTMLInputElement) {
	if (!closedBridge) return;
	closedBusy.value = true;
	closedError.value = '';
	const r = await toggleClosedNotifyBox(closedBridge, box, closedEnabled.value);
	closedEnabled.value = r.enabled;
	if (!r.error) closedActive.value = r.enabled;   // a success means the task was made (or removed)
	closedError.value = r.error;
	closedBusy.value = false;
}

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

// Each visit to this tab subscribes; leaving it must unsubscribe, or the listeners pile up for the
// life of the window (review 2.10). `gone` covers leaving before getUpdateInfo() has answered.
let unsubscribeStatus: (() => void) | null = null;
let gone = false;
onMounted(async () => {
	if (!window.forceApp) return;
	const info = await window.forceApp.getUpdateInfo();
	if (gone) return;
	appVersion.value = info.version;
	packaged.value = info.packaged;
	updateStatus.value = info.status;
	unsubscribeStatus = window.forceApp.onUpdateStatus((s) => { updateStatus.value = s; });
	if (closedBridge) {
		const c = await loadClosedNotify(closedBridge);
		if (gone) return;
		closedSupported.value = c.supported;
		closedEnabled.value = c.enabled;
		closedActive.value = c.active;
	}
});
onBeforeUnmount(() => { gone = true; unsubscribeStatus?.(); unsubscribeStatus = null; });

// The id a rig-test request's `rig:` line is matched against (FORCE_APP_RIG_ID, else "rig").
// An older recorder has no such route; the line just stays hidden.
const rigId = ref('');
onMounted(async () => {
	const r = await getEligibility();
	if (!gone && r.kind === 'ok') rigId.value = r.data.rig_id;
});
</script>

<template>
	<div class="about">
		<h2>Version</h2>
		<p class="lead">
			<template v-if="isElectron">Force App {{ appVersion || '…' }}<span v-if="!packaged"> (dev build — auto-update is disabled)</span></template>
			<template v-else>Browser build — version and updates are managed by the desktop app.</template>
		</p>

		<p v-if="rigId" class="rig-id">Rig ID: <code>{{ rigId }}</code> <span class="rig-id-sub">(a rig-test request's <code>rig:</code> line must match this)</span></p>

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

			<label v-if="closedSupported" class="notify-toggle">
				<input type="checkbox" :checked="closedEnabled" :disabled="closedBusy"
					@change="toggleClosedNotify($event.target as HTMLInputElement)" />
				<span>Notify me about updates when the app is closed</span>
			</label>
			<p v-if="closedSupported" class="hint">A small Windows scheduled task checks for a new version at sign-in and once a day and shows a notification. It never installs anything.</p>
			<p v-if="closedNotifyWarning(closedSupported, closedEnabled, closedActive)" class="err">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">error</span> {{ closedNotifyWarning(closedSupported, closedEnabled, closedActive) }}
			</p>
			<p v-if="closedError" class="err">
				<span class="material-symbols-rounded" style="font-size: var(--icon-xs)">error</span> {{ closedError }}
			</p>
		</template>

		<!-- The window is about to close and silently reinstall — without this the app just vanishes
			 the instant "Restart and install" is clicked, which reads as a crash. The main process also
			 fires an OS notification (covers the case where the update dialog is answered from outside
			 this page), but this overlay is the clearer signal when the operator IS looking at this
			 page. Held up for ~800ms by the main process before the process actually quits, so this has
			 time to paint. -->
		<div v-if="isElectron && updateStatus.state === 'installing'" class="install-overlay">
			<ThinkingOrb :size="48" label="" />
			<p>Installing version {{ updateStatus.version }}…</p>
			<p class="sub">The app will close and reopen automatically — this takes a few seconds.</p>
		</div>

		<div class="changelog-head mt">
			<h2>What's new</h2>
			<!-- #43 -->
			<a href="https://github.com/STAR-Titanium-Research/STARbase/releases" target="_blank" rel="noopener" class="releases-link">
				<span class="material-symbols-rounded">open_in_new</span> View all releases on GitHub
			</a>
		</div>
		<!-- #44: this list only ever grows (one entry per release, never pruned), so without its own
			 scroll area it eventually pushes the whole Settings window's height along with it. -->
		<div class="changelog">
			<div v-for="c in ENTRIES" :key="c.version" class="entry" :class="{ current: isElectron && c.version === appVersion }">
				<div class="entry-head">
					<span class="entry-version">v{{ c.version }}</span>
					<span v-if="isElectron && c.version === appVersion" class="badge current-badge">running now</span>
					<span class="entry-date">{{ c.date }}</span>
				</div>
				<!-- #137: notes are grouped by their leading Fixed:/Improved:/New: prefix (changelogGroups.ts). -->
				<template v-for="g in c.groups" :key="g.key">
					<h4 class="group-head" :class="g.key">{{ g.label }}</h4>
					<ul>
						<li v-for="n in g.notes" :key="n">{{ n }}</li>
					</ul>
				</template>
			</div>
		</div>
	</div>
</template>

<style scoped>
.about { max-width: 640px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.mt { margin-top: 32px; }
.lead { margin: 0 0 12px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.rig-id { margin: 0 0 12px; font-size: var(--fs-md); color: var(--text); }
.rig-id-sub { color: var(--text-dim); font-size: var(--fs-sm); }
.hint { display: flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-dim); margin-top: 4px; }
.err { display: flex; align-items: center; gap: 5px; color: var(--danger); font-size: var(--fs-sm); margin: 4px 0 0; }
.actions { display: flex; gap: 10px; margin-top: 6px; }
.notify-toggle { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: var(--fs-md); color: var(--text); cursor: pointer; }

.install-overlay { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column;
	align-items: center; justify-content: center; gap: 6px; background: rgba(0,0,0,0.75); color: #fff; text-align: center; }
/* The overlay is near-black in both themes, so the orb keeps the dark theme's inks here. */
.install-overlay .thinking-orb { margin-bottom: 6px; --fx-ink: #f87171; --fy-ink: #4ade80; --fz-ink: #60a5fa; --text-dim: rgba(255, 255, 255, 0.55); }
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
.group-head { margin: 10px 0 4px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text); }
.group-head:first-of-type { margin-top: 0; }
.entry ul {margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.entry li { font-size: var(--fs-md); color: var(--text-dim); line-height: 1.45; }
</style>
