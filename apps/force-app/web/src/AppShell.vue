<script setup lang="ts">
// Persistent app shell: a left vertical-tab sidebar (Record / Plot / Lab Amp / Settings) with the
// active section rendered in the main area. Replaces the old select page.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { authStore } from './authStore';
import { syncStatus } from './record/directusSync';
import { hwStatus } from './record/hwStatus';
import { alarmController } from './record/alarms';
import { appUrl } from './appUrl';
import { getConfig } from './config';
import { formatDuration } from './format';
import { bannerRunFromStatus, type BannerRun } from './record/recordingBanner';
import OfflineSessionBanner from './OfflineSessionBanner.vue';

const router = useRouter();
const route = useRoute();

// Belt-and-suspenders: alarms are already a fresh module-lifetime singleton on a true app
// relaunch (verified — no hide-to-tray/backend persistence to leak state across sessions), but
// reset here too since AppShell is the one component guaranteed to mount exactly once per launch.
onMounted(() => alarmController.reset());

// Cross-page "recording in progress" banner. RecordPage.vue's own state (hwStatus, w.client) is
// torn down on navigation away from /record (onBeforeUnmount there explicitly clears hwStatus and
// disconnects the websocket) — recording itself is server-side and keeps running regardless, so
// this polls the backend directly, independent of whether RecordPage is even mounted.
const recording = ref<BannerRun | null>(null);
// #22: elapsedSec above only refreshes once per 5s poll, so displaying it directly made the
// banner's clock visibly jump in 5-second steps instead of ticking live. elapsedBase/-At snapshot
// each poll's value and the moment it arrived; displayedElapsedSec (below) extrapolates from that
// snapshot on a fast local tick, the same base+performance.now()-delta pattern RecordPage.vue's
// recoveryElapsed() uses for the same reason.
let elapsedBaseSec = 0;
let elapsedBaseAt = 0;
const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;
const displayedElapsedSec = computed(() => {
	void tick.value;
	// A run that is only being saved has stopped: its clock is final.
	if (recording.value?.phase === 'finalizing') return elapsedBaseSec;
	return elapsedBaseSec + (performance.now() - elapsedBaseAt) / 1000;
});
const bannerDismissedFor = ref<string | null>(null);
let recordingPollTimer: ReturnType<typeof setInterval> | null = null;
async function pollRecordingStatus() {
	try {
		const base = getConfig().recorderUrl;
		const res = await fetch(`${base}/record/status`);
		if (!res.ok) { recording.value = null; return; }
		const data = await res.json();
		const run = bannerRunFromStatus(data);
		if (run) {
			elapsedBaseSec = run.elapsedSec;
			elapsedBaseAt = performance.now();
			if (run.phase === 'recording') {
				if (!tickTimer) tickTimer = setInterval(() => { tick.value++; }, 250);
			} else if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
			recording.value = run;
		} else {
			recording.value = null;
			if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
		}
	} catch { recording.value = null; }
}
const showBanner = computed(() =>
	!!recording.value && route.path !== '/record' && bannerDismissedFor.value !== recording.value.id,
);
function dismissBanner() { if (recording.value) bannerDismissedFor.value = recording.value.id; }
function fmtSamples(n: number): string {
	return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
}
onMounted(() => { pollRecordingStatus(); recordingPollTimer = setInterval(pollRecordingStatus, 5000); });
onBeforeUnmount(() => {
	if (recordingPollTimer) clearInterval(recordingPollTimer);
	if (tickTimer) clearInterval(tickTimer);
});
const userName = computed(() => {
	const u = authStore.currentUser.value;
	if (!u) return '';
	return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '';
});
const nav = [
	{ to: '/record', icon: 'fiber_manual_record', label: 'Record' },
	{ to: '/plot', icon: 'insights', label: 'Plot' },
	{ to: '/diagnostics', icon: 'query_stats', label: 'Diagnostics' },
	{ to: '/labamp', icon: 'memory', label: 'Lab Amp' },
	{ to: '/nidaq', icon: 'cable', label: 'NI-DAQ' },
	{ to: '/settings', icon: 'settings', label: 'Settings' },
];
async function signOut() { await authStore.logout(); router.replace('/login'); }
// Collapsed to a 3-vertical-dot handle at the left-middle of the screen most of the time — it
// overlays the page rather than reserving a permanent 96px column, sliding out on hover so it
// doesn't compete with the recording panels for width.
const expanded = ref(false);
// Hover still opens it for the mouse, but the handle is a real button so the keyboard (Tab to it,
// Enter) and touch (tap) can open it too: the links were display:none until hovered, which left
// the app's only navigation unreachable without a mouse. Opened that way it is "pinned" — it
// stays open until focus or a tap leaves it, or Escape.
const navEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const mainEl = ref<HTMLElement | null>(null);
let pinned = false;
function openFromTrigger(e: MouseEvent) {
	expanded.value = true;
	pinned = true;
	// detail 0 = activated from the keyboard: put focus on the current section's link.
	if (e.detail === 0) {
		void nextTick(() => (navEl.value?.querySelector<HTMLElement>('.navitem.active') ?? navEl.value?.querySelector<HTMLElement>('.navitem'))?.focus());
	}
}
function collapse(refocusTrigger = false) {
	expanded.value = false;
	pinned = false;
	if (refocusTrigger) void nextTick(() => triggerEl.value?.focus());
}
function onMouseLeave() { if (!pinned) expanded.value = false; }
function onFocusOut(e: FocusEvent) {
	if (pinned && !navEl.value?.contains(e.relatedTarget as Node | null)) collapse();
}
// Touch has no mouseleave: a tap anywhere outside closes it.
function onDocPointerDown(e: PointerEvent) {
	if (expanded.value && navEl.value && e.target instanceof Node && !navEl.value.contains(e.target)) collapse();
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true));
// Navigating from a pinned sidebar closes it and hands focus to the page, rather than leaving it
// on a link that has just been hidden.
watch(() => route.path, () => {
	if (!pinned) return;
	collapse();
	void nextTick(() => mainEl.value?.focus({ preventScroll: true }));
});
// Multi-monitor: pop a section into its own window (e.g. Plot while recording). Same origin, so the
// new window shares the login; the recording backend is a single session but plotting is read-only.
function openWindow(to: string) { window.open(appUrl(to), '_blank', 'noopener,width=1500,height=950'); }
</script>

<template>
	<div class="shell">
		<nav ref="navEl" class="sidebar" :class="{ expanded }" aria-label="Main navigation"
			@mouseenter="expanded = true" @mouseleave="onMouseLeave" @focusout="onFocusOut" @keydown.esc="collapse(true)">
			<button ref="triggerEl" v-show="!expanded" type="button" class="trigger" aria-label="Open navigation" title="Navigation"
				:aria-expanded="expanded" @click="openFromTrigger">
				<span class="vdot fx"></span><span class="vdot fy"></span><span class="vdot fz"></span>
			</button>
			<div class="navwrap" v-show="expanded">
				<div class="brand">
					<span class="brand-mark"><i class="dot fx"></i><i class="dot fy"></i><i class="dot fz"></i></span>
					<span class="brand-name">Force</span>
				</div>
				<div v-for="n in nav" :key="n.to" class="navrow">
					<router-link :to="n.to" class="navitem" active-class="active">
						<span class="material-symbols-rounded">{{ n.icon }}</span>
						<span class="lbl">{{ n.label }}</span>
						<span v-if="n.to === '/settings' && syncStatus.pending > 0" class="badge warn">{{ syncStatus.pending }}</span>
						<span v-if="n.to === '/record' && alarmController.tripped" class="badge alarm">!</span>
					</router-link>
					<button class="popout" title="Open in a new window (for a second monitor)" @click="openWindow(n.to)">
						<span class="material-symbols-rounded">open_in_new</span>
					</button>
				</div>
				<div class="spacer"></div>
				<div class="statuswrap">
					<div v-if="syncStatus.pending > 0 || syncStatus.lastError" class="chip" :class="syncStatus.pending > 0 ? 'warn' : 'err'"
						:title="syncStatus.lastError || (syncStatus.needsSignIn ? `${syncStatus.pending} run record(s) queued — sign in while connected to upload` : syncStatus.waitingForOthers > 0 ? `${syncStatus.pending} run record(s) queued (${syncStatus.waitingForOthers} recorded by someone else: they upload when they sign in)` : `${syncStatus.pending} run record(s) queued offline`)">
						<span class="material-symbols-rounded">{{ syncStatus.pending > 0 ? 'cloud_queue' : 'error' }}</span>
						<span v-if="syncStatus.pending > 0" class="chip-lbl">{{ syncStatus.pending }}</span>
					</div>
					<div v-if="hwStatus.diskFreeGb >= 0" class="chip" :class="{ warn: hwStatus.diskFreeGb < 10, crit: hwStatus.diskFreeGb < 5 }"
						:title="`${hwStatus.diskFreeGb.toFixed(1)} GB free of ${hwStatus.diskTotalGb.toFixed(0)} GB`">
						<span class="material-symbols-rounded">hard_drive</span>
						<span class="chip-lbl">{{ hwStatus.diskFreeGb < 100 ? hwStatus.diskFreeGb.toFixed(1) : Math.round(hwStatus.diskFreeGb) }} GB</span>
					</div>
					<div v-if="hwStatus.backupEnabled" class="chip"
						:class="{ warn: hwStatus.backupState === 'paused', ok: hwStatus.backupState === 'streaming', err: hwStatus.backupState === 'error' }"
						:title="hwStatus.backupError || `Backup ${hwStatus.backupState || 'idle'} · ${hwStatus.backupProgress.toFixed(0)}%`">
						<span class="material-symbols-rounded">{{ hwStatus.backupConnected ? 'cloud_done' : 'cloud_off' }}</span>
						<span v-if="hwStatus.backupState === 'streaming'" class="chip-lbl">{{ hwStatus.backupProgress.toFixed(0) }}%</span>
					</div>
					<div v-if="hwStatus.diskFreeGb >= 0" class="chip" :class="{ ok: hwStatus.connected }" :title="hwStatus.connected ? 'Backend connected' : 'Backend disconnected'">
						<span class="material-symbols-rounded">{{ hwStatus.connected ? 'sensors' : 'sensors_off' }}</span>
					</div>
				</div>
				<div class="user">
					<span class="who">{{ userName }}</span>
					<button class="btn icon" title="Sign out" @click="signOut"><span class="material-symbols-rounded">logout</span></button>
				</div>
			</div>
		</nav>
		<main ref="mainEl" class="content" :class="{ fill: route.meta.fillViewport }" tabindex="-1">
			<OfflineSessionBanner />
			<div v-if="showBanner" class="rec-banner">
				<span class="rec-banner-dot"></span>
				<span class="rec-banner-name">{{ recording!.phase === 'finalizing' ? 'Saving' : 'Recording' }} — {{ recording!.sampleName }}</span>
				<span class="rec-banner-stats">
					<span class="rec-stat"><b>{{ formatDuration(displayedElapsedSec) }}</b> elapsed</span>
					<span class="rec-stat"><b>{{ fmtSamples(recording!.samples) }}</b> samples</span>
					<span class="rec-stat"><b>{{ recording!.peakN.toFixed(0) }} N</b> peak</span>
				</span>
				<router-link to="/record" class="btn sm inverse primary rec-banner-link">Go to Recording</router-link>
				<button class="btn icon sm inverse" title="Dismiss" @click="dismissBanner"><span class="material-symbols-rounded">close</span></button>
			</div>
			<!-- Every other route remounts on each navigation (cheap, and Record relies on its own
			     unmount to disconnect its websocket). Plot alone is cached: it fetches the full
			     samples/operations list and rebuilds octree loaders on mount, which is expensive
			     enough that leaving /plot and coming back used to feel like a full page reload (#15). -->
			<router-view v-slot="{ Component }">
				<keep-alive include="StandaloneForceDashboard">
					<component :is="Component" />
				</keep-alive>
			</router-view>
		</main>
	</div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; }
.sidebar {
	/* Collapsed state is an invisible 30x120 hitbox (mouseenter/mouseleave live here) — much more
	   forgiving to hover than the visible pill, which stays its original small size (see .trigger). */
	position: fixed; top: 50%; left: 0; transform: translateY(-50%); z-index: 200;
	width: 30px; height: 120px; overflow: visible;
	display: flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 4px; padding: 0;
	transition: width 0.16s ease, height 0.16s ease, border-radius 0.16s ease, top 0.16s ease, transform 0.16s ease, padding 0.16s ease;
}
.sidebar.expanded {
	top: var(--offline-banner-h, 0px); transform: translateY(0); width: 96px; height: calc(100vh - var(--offline-banner-h, 0px)); padding: 8px; border-radius: 0; overflow: hidden;
	background: var(--bg-2); border-top: 1px solid var(--border); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
	box-shadow: 8px 0 28px rgba(0,0,0,0.28);
}
.trigger {
	/* margin: 0, not 0 auto — this pill's left edge is deliberately square (border-radius only on
	   the right) so it can sit flush against the screen's left border; centering it in the wider
	   .sidebar hitbox left an ~8px gap instead (#13). */
	display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
	width: 14px; height: 64px; margin: 0; padding: 8px 2px; overflow: hidden;
	background: var(--bg-2); border-top: 1px solid var(--border); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
	border-radius: 0 14px 14px 0;
	border-left: 0; cursor: pointer; color: inherit; font: inherit;
}
.vdot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
.vdot.fx { background: var(--fx); } .vdot.fy { background: var(--fy); } .vdot.fz { background: var(--fz); }
.navwrap { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 4px; }
.brand { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 0 0 8px; flex-shrink: 0; }
.brand-mark { display: inline-flex; gap: 3px; padding: 6px; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); }
.dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.dot.fx { background: var(--fx); } .dot.fy { background: var(--fy); } .dot.fz { background: var(--fz); }
.brand-name { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; color: var(--text-dim); }
.navrow { position: relative; flex-shrink: 0; }
.popout { position: absolute; top: 4px; right: 4px; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-dim); cursor: pointer; opacity: 0; transition: opacity 0.14s; }
.popout .material-symbols-rounded { font-size: var(--icon-xs); }
.navrow:hover .popout, .navrow:focus-within .popout { opacity: 1; }
.popout:hover { color: var(--accent); }
.navitem { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 10px 4px; border-radius: 10px; color: var(--text-dim); text-decoration: none; transition: background 0.14s, color 0.14s; }
.navitem .material-symbols-rounded { font-size: var(--icon-xl); }
.navitem .lbl { font-size: var(--fs-xs); font-weight: 600; }
.navitem:hover { background: var(--surface); color: var(--text); }
.navitem.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.badge { position: absolute; top: 6px; right: 18px; min-width: 15px; height: 15px; padding: 0 3px; display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-xs); font-weight: 700; border-radius: 8px; }
.badge.warn { color: #0b1020; background: #fbbf24; }
.badge.alarm { color: #fff; background: #ef4444; animation: alarmpulse 0.9s ease-in-out infinite; }
.spacer { flex: 1; }
.statuswrap { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.chip { display: inline-flex; align-items: center; justify-content: center; gap: 3px; width: 100%; padding: 4px 2px; border-radius: 7px; font-size: var(--fs-xs); font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text-dim); border: 1px solid var(--border); }
.chip .material-symbols-rounded { font-size: var(--icon-sm); }
.chip.ok { color: var(--ok); }
.chip.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.chip.crit { color: #ef4444; background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.3); animation: alarmpulse 0.9s ease-in-out infinite; }
.chip.err { color: var(--danger); background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.3); }
@keyframes alarmpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
.user { display: flex; flex-direction: column; align-items: center; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.who { font-size: var(--fs-xs); color: var(--text-dim); text-align: center; word-break: break-word; max-width: 82px; }
/* The sidebar is fixed/overlaid — it expands over the page on hover rather than pushing content —
   so content needs no reserved margin at all; the collapsed left-middle dot handle sits on top of it. */
/* A page that owns its scrolling (route meta.fillViewport -- Settings, #30) gets exactly the
   viewport, banners included, as a flex column: nothing can overflow the document and the page's
   own pane scrolls. Every other page is laid out exactly as before (plain block content that
   scrolls the document); only `.fill` changes anything. */
.content { flex: 1; min-width: 0; }
.content.fill { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.content.fill > .rec-banner, .content.fill > :deep(.off-banner) { flex-shrink: 0; }
.content:focus { outline: none; } /* a programmatic focus target after navigation, not a control */
/* Blue, not red. A healthy recording in progress is information, not a fault — #dc2626 here was the
   exact colour the forced-stop and safety-alarm banners use, so a normal run looked like a failure
   every time the operator left the Record page. #2563eb is the same informational blue
   .disk-action-banner.backup_started already uses. The pulsing dot still reads as "live". */
.rec-banner { --banner: #2563eb; position: sticky; top: 0; z-index: 150; display: flex; align-items: center; gap: 12px; padding: 8px 16px; font-size: var(--fs-md); font-weight: 600; color: #fff; background: #2563eb; }
.rec-banner-dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; flex-shrink: 0; --pulse-color: #fff; animation: live-pulse 1.4s infinite; }
.rec-banner-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rec-banner-stats { display: flex; align-items: center; gap: 14px; font-weight: 500; color: rgba(255,255,255,0.85); font-variant-numeric: tabular-nums; }
.rec-stat b { font-weight: 700; color: #fff; }
.rec-banner-link { margin-left: auto; }
</style>
