<script setup lang="ts">
// Modular Recording workspace: a draggable/resizable grid of panels (Recording Options, Metadata,
// Force Plot w/ FFT, FRM Map, Plot Options), mirroring the Directus force-analysis feel. Layout is
// persisted to localStorage; panels share one workspace store via provide/inject.
import { onMounted, onBeforeUnmount, provide, reactive, ref, watch, watchEffect, computed } from 'vue';
import { GridLayout, GridItem } from 'grid-layout-plus';
import { getWorkspace, WORKSPACE } from './workspace';
import { startSync } from './directusSync';
import { hwStatus } from './hwStatus';
import { labamp } from './labampApi';
import { IntervalGate, shouldPollBackup, shouldPollPreflight, syncDiskGate } from './recordPolling';
import { DEFAULT_LAYOUT, dockPanel, GRID_COLS, oppositeSide, parseDismissedIds, parseSavedLayout, type RecordPanelInst as Inst } from './recordLayout';
import PanelFrame from './panels/PanelFrame.vue';
import { PLOT_MODES, type PlotMode } from './plotModes';
import { PlotModeFlyout } from '@d1/force-plotting';
import RecordingOptions from './panels/RecordingOptions.vue';
import RecordingActions from './panels/RecordingActions.vue';
import ForcePanel from './panels/ForcePanel.vue';
import FrmPanel from './panels/FrmPanel.vue';
import PolarPanel from './panels/PolarPanel.vue';
import RpmPanel from './panels/RpmPanel.vue';
import OverviewPanel from './panels/OverviewPanel.vue';
import SaveCutDialog from './panels/SaveCutDialog.vue';
import { confirmAction, confirmState } from '../ui/confirm';
import { resolveShortcut, type ShortcutContext } from './shortcuts';


// #25: getWorkspace() returns a lazily-built module-level singleton (see workspace.ts) so its
// live buffers/config survive this component unmounting and remounting -- not a fresh instance
// per mount.
const w = getWorkspace();
provide(WORKSPACE, w);
const st = w.st;

// Panel types. `single` types exist at most once; the rest can be added multiple times (e.g. two
// Force panels each isolating a different axis, or a second FRM). `w/h` seed a newly-added panel.
const PANEL_TYPES: Record<string, { title: string; icon: string; single?: boolean; w: number; h: number }> = {
	options: { title: 'Recording & Metadata', icon: 'tune', single: true, w: 2, h: 28 },
	overview: { title: 'Overview', icon: 'monitoring', w: 4, h: 4 },
	force: { title: 'Force Plot', icon: 'show_chart', w: 6, h: 11 },
	rpm: { title: 'RPM', icon: 'speed', w: 6, h: 7 },
	frm: { title: 'FRM Map', icon: 'fingerprint', w: 4, h: 19 },
	polar: { title: 'Polar Plot', icon: 'radar', w: 4, h: 16 },
};
const LS_KEY = 'force-app.record.layout.v7';

function loadLayout(): Inst[] {
	// Unknown panel types are skipped, not fatal (invariant 11) — see recordLayout.ts.
	let raw: string | null = null;
	try { raw = localStorage.getItem(LS_KEY); } catch { /* storage unavailable: default layout */ }
	return parseSavedLayout<Inst>(raw, PANEL_TYPES) ?? DEFAULT_LAYOUT.map((x) => ({ ...x }));
}
const layout = ref<Inst[]>(loadLayout());
let saveT: any = null;
watch(layout, (l) => { clearTimeout(saveT); saveT = setTimeout(() => localStorage.setItem(LS_KEY, JSON.stringify(l)), 400); }, { deep: true });
// Asks first: the button sits right beside "Add a panel", and a reset throws away every panel's
// position, size, mode and channel picks at once, with no undo.
async function resetLayout() {
	const ok = await confirmAction({
		title: 'Reset the panel layout?',
		message: 'Every panel returns to its default position and size, and panels you added or closed go back to the default set, with their modes and channel choices.',
		detail: 'Recording settings and data are not affected.',
		confirmLabel: 'Reset layout',
	});
	if (ok) layout.value = DEFAULT_LAYOUT.map((x) => ({ ...x }));
}
// #136: dragging the full-height Recording & Metadata panel across the grid only pushed the panels it
// landed on below the bottom row. dockPanel moves its column strip instead; the layout watcher saves it.
function moveOptionsPanel() {
	layout.value = dockPanel(layout.value, 'options', oppositeSide(layout.value, 'options', GRID_COLS), GRID_COLS);
}

// ---- Responsive grid height ----------------------------------------------------------------
// The grid's own height is `bottomRow * (rowHeight + marginY) + marginY` (grid-layout-plus), so a
// FIXED row height pins the whole workspace to one pixel height no matter the window size — the
// default 28-row layout came out at 28*(30+12)+12 = 1188px, overflowing a 1080p screen and leaving
// a gap on a taller one. Measuring the viewport and inverting that formula makes the panels fill
// the window exactly instead.
const GRID_MARGIN = 12;   // must match :margin="[12, 12]" on GridLayout below
const MIN_ROW_H = 18;     // floor: past this a tall layout scrolls rather than squashing to nothing
const BOTTOM_PAD = 2;     // minimal breathing room — panels are allowed to run under the
                          // floating panel-controls cluster rather than leaving a big gap

const gridEl = ref<HTMLElement | null>(null);
const availableHeight = ref(700);
function measureGrid() {
	if (!gridEl.value) return;
	// Measured from the grid's own top, so the conditional disk-action / recovery banners (which
	// push the grid down when they appear) are accounted for automatically. .alarm-overlay is
	// position:fixed and correctly costs no flow height.
	//
	// Document offset, not the viewport-relative rect: when the layout is taller than the window
	// it scrolls (by design, past the min row height), and a scrolled rect has a negative top.
	// Using that directly inflates availableHeight, which grows the rows, which makes the page
	// taller still — a feedback loop that runs away as the user scrolls. The document offset is
	// scroll-invariant, so the measurement means the same thing wherever the page happens to be.
	const top = gridEl.value.getBoundingClientRect().top + window.scrollY;
	// #51: .rec-wrap carries its own padding-bottom BELOW the grid, which this measurement used to
	// ignore entirely -- so the grid was sized to reach the viewport floor and that padding then
	// pushed the page past it, giving the default layout a permanent ~8px scrollbar. Read it from
	// the live computed style rather than hardcoding, so the two cannot drift apart again.
	const wrap = gridEl.value.closest('.rec-wrap');
	const below = wrap ? parseFloat(getComputedStyle(wrap).paddingBottom) || 0 : 0;
	availableHeight.value = Math.max(320, Math.floor(window.innerHeight - top - below - BOTTOM_PAD));
}
// Derived from the LIVE layout, not the default: `layout` is user-editable and persisted, so the
// row span is arbitrary after any drag/resize/add.
const bottomRow = computed(() => layout.value.reduce((m, p) => Math.max(m, p.y + p.h), 0) || 1);
const rowHeight = computed(() =>
	Math.max(MIN_ROW_H, Math.floor((availableHeight.value - GRID_MARGIN) / bottomRow.value) - GRID_MARGIN),
);

let gridRO: ResizeObserver | undefined;

// Below this width the drag/resize grid has no room to lay panels side by side without squeezing
// their contents unreadable — fall back to a plain single-column stack (drag/resize disabled,
// since there's nothing left to rearrange against) instead of trying to force the 12-col grid
// into a space it was never designed for.
const NARROW_BREAKPOINT = 640;
const narrow = ref(false);
function checkNarrow() { narrow.value = window.innerWidth < NARROW_BREAKPOINT; }
const stackedLayout = computed<Inst[]>(() => {
	const sorted = [...layout.value].sort((a, b) => a.y - b.y || a.x - b.x);
	let y = 0;
	return sorted.map((p) => {
		const item = { ...p, x: 0, y, w: 1 };
		y += p.h;
		return item;
	});
});
// Two-way only in the normal (wide) case — the stacked view is a derived read-only projection,
// and dragging is disabled there anyway so the setter never fires while narrow.
const displayLayout = computed<Inst[]>({
	get: () => (narrow.value ? stackedLayout.value : layout.value),
	set: (v) => { if (!narrow.value) layout.value = v; },
});

const addOpen = ref(false);
const hasType = (t: string) => layout.value.some((p) => p.type === t);
function addPanel(type: string) {
	addOpen.value = false;
	const meta = PANEL_TYPES[type];
	if (meta.single && hasType(type)) return;
	const maxY = layout.value.reduce((m, p) => Math.max(m, p.y + p.h), 0);
	const inst: Inst = { i: `${type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type, x: 0, y: maxY, w: meta.w, h: meta.h };
	if (type === 'force') { inst.mode = 'time'; inst.channels = ['Fx', 'Fy', 'Fz']; }
	layout.value = [...layout.value, inst];
}
function closePanel(i: string) { layout.value = layout.value.filter((p) => p.i !== i); }
const addable = computed(() => Object.entries(PANEL_TYPES).map(([type, m]) => ({ type, ...m, disabled: !!m.single && hasType(type) })));

// Periodic disk space check during recording (every 30s)
const diskInfo = reactive<{ free_gb: number; total_gb: number; used_pct: number; checking: boolean }>({ free_gb: -1, total_gb: 0, used_pct: 0, checking: false });
async function checkDisk() {
	try {
		diskInfo.checking = true;
		const res = await fetch(`${w.client.baseUrl}/storage/config`);
		if (res.ok) {
			const data = await res.json();
			diskInfo.free_gb = data.free_gb ?? -1;
			diskInfo.total_gb = data.total_gb ?? 0;
			diskInfo.used_pct = data.used_pct ?? 0;
			// Also polled while idle for the pre-Start checklist: that must not raise the alarm.
			if (st.state === 'recording') w.alarms.evaluateDisk(diskInfo.free_gb);
		}
	} catch { /* backend unreachable */ } finally { diskInfo.checking = false; }
}
// Guarded to record mode: play() marks status 'recording' too (see playback/engine.ts), and
// polling disk/backup status for an archived cut that writes nothing would be pure noise —
// playback's only backend traffic is its own throttled /dsp/spectrum call. `immediate`: the page
// may mount (or the reconcile may adopt a cut) while already recording, with no state change left
// to trigger the watcher (review 2.6).
const diskGate = new IntervalGate(checkDisk, 30_000);
// R4: while waiting to Start, the disk poll also feeds the checklist's runway (preflight.ts reads
// hwStatus.diskFreeGb), and its other inputs (amp mode, saved channel list, NI-DAQ only) are
// refreshed on the same terms and whenever the source changes.
const preflightGate = new IntervalGate(() => { void w.refreshPreflight(); }, 15_000);
watch([() => st.state, () => w.mode.value], ([s, m], old) => {
	syncDiskGate(diskGate, m, s, old?.[0] && old[1] ? { state: old[0], mode: old[1] } : undefined);
	preflightGate.set(shouldPollPreflight(m, s));
}, { immediate: true });
watch(() => w.source.value, () => { void w.refreshPreflight(); });

// ---- Live backup status ----
const backupStatus = reactive<{ enabled: boolean; state: string; progress: number; connected: boolean; error: string | null }>({
	enabled: false, state: '', progress: 0, connected: false, error: null,
});
async function checkBackup() {
	try {
		const res = await fetch(`${w.client.baseUrl}/backup/status`);
		if (res.ok) {
			const data = await res.json();
			backupStatus.enabled = data.enabled;
			if (data.active) {
				backupStatus.state = data.active.state;
				backupStatus.progress = data.active.progress_pct;
				backupStatus.connected = data.active.connected;
				backupStatus.error = data.active.error;
			} else {
				backupStatus.state = '';
				backupStatus.progress = 0;
			}
		}
	} catch { /* ignore */ }
}
// One last read when polling stops, so the chip shows the final state.
const backupGate = new IntervalGate(checkBackup, 5_000, () => { void checkBackup(); });
// backupStatus.enabled is only known after the first reply, which on a remount arrives after the
// state is already 'recording' — so it is a source too.
watch([() => st.state, () => w.mode.value, () => backupStatus.enabled],
	([s, m, en]) => backupGate.set(shouldPollBackup(m, s, en)), { immediate: true });

// Mirror this page's local status state into the shared singleton AppShell's sidebar reads from,
// since the sidebar is mounted on every route (not just Record) and has no access to this instance.
watchEffect(() => {
	hwStatus.connected = st.connected;
	hwStatus.diskFreeGb = diskInfo.free_gb;
	hwStatus.diskTotalGb = diskInfo.total_gb;
	hwStatus.backupEnabled = backupStatus.enabled;
	hwStatus.backupState = backupStatus.state;
	hwStatus.backupProgress = backupStatus.progress;
	hwStatus.backupConnected = backupStatus.connected;
	hwStatus.backupError = backupStatus.error;
});

// ---- Recovery of incomplete recordings ----
interface IncompleteSession {
	id: string;
	started_iso: string;
	raw: { n_rows: number; duration_sec: number; rate: number; raw_size_mb: number };
	manifest?: { config?: { sample_name?: string } } | null;
}
const recoveryItems = ref<IncompleteSession[]>([]);
// #27: "dismiss for now" without recovering or discarding -- the crashed capture stays exactly
// where it is on disk (still visible to the health-doctor's "Crashed recordings" check and
// the Connectivity doctor's purge fix), this only stops the Record page banner from nagging about
// it every visit. Persisted (not just this component's lifetime) since "deal with it later" means
// "maybe after restarting the app," not just "for the rest of this session."
const DISMISSED_RECOVERY_LS_KEY = 'force-app.dismissedRecoveryIds';
const dismissedRecoveryIds = ref<Set<string>>(
	(() => { try { return parseDismissedIds(localStorage.getItem(DISMISSED_RECOVERY_LS_KEY)); } catch { return new Set<string>(); } })(),
);
function dismissRecovery(id: string) {
	dismissedRecoveryIds.value.add(id);
	localStorage.setItem(DISMISSED_RECOVERY_LS_KEY, JSON.stringify([...dismissedRecoveryIds.value]));
}
// #83: an ignored capture used to vanish from here for good while the Connectivity doctor kept
// flagging it, with no way back to it from this page. Ignored ones are counted and can be shown
// again (per capture, or all at once).
function unignoreRecovery(id: string) {
	dismissedRecoveryIds.value.delete(id);
	localStorage.setItem(DISMISSED_RECOVERY_LS_KEY, JSON.stringify([...dismissedRecoveryIds.value]));
}
const showIgnoredRecovery = ref(false);
const ignoredRecoveryCount = computed(() => recoveryItems.value.filter((s) => dismissedRecoveryIds.value.has(s.id)).length);
const visibleRecoveryItems = computed(() => recoveryItems.value.filter(
	(s) => showIgnoredRecovery.value || !dismissedRecoveryIds.value.has(s.id),
));
const recoveryBannerShown = computed(() => visibleRecoveryItems.value.length > 0 || ignoredRecoveryCount.value > 0);

// #36: ResizeObserver only reports the OBSERVED element's own box size changing -- a banner above
// the grid appearing/disappearing shifts the grid's top (via normal document flow) without
// necessarily changing the grid element's own rendered height, so gridRO can silently miss it.
// Watching the banners' own visibility directly is the actual fix, not a coincidence of some
// other resize.
//
// Must stay BELOW visibleRecoveryItems' declaration: watch() invokes its source getters once
// immediately to collect dependencies, so declaring this any earlier put `visibleRecoveryItems`
// in its temporal dead zone and threw ReferenceError on every single RecordPage setup. Vue's
// error boundary swallowed it, so the page still rendered -- but dep collection aborted at the
// throw, leaving this watcher permanently blind to the recovery banner (it kept the diskAction
// dep, read before the throw, which is why it looked half-working).
watch([() => !!st.diskAction, () => !!w.railBanner.value, () => recoveryBannerShown.value], () => measureGrid(), { flush: 'post' });

const recoveryBusy = ref<Record<string, boolean>>({});
// Recover/discard on a crashed session's raw.d1raw can take a while for a large/long-running
// capture (finalize has to re-derive everything, discard has to delete a potentially multi-GB
// file) — previously the button just went disabled with no further feedback, which read as hung.
// Track a start time per id and tick a shared clock so the button can show live elapsed seconds.
const recoveryBusyStart = ref<Record<string, number>>({});
const recoveryTick = ref(0);
let recoveryTickTimer: ReturnType<typeof setInterval> | null = null;
function recoveryElapsed(id: string): number {
	void recoveryTick.value;
	const t = recoveryBusyStart.value[id];
	return t ? (performance.now() - t) / 1000 : 0;
}
function beginRecoveryBusy(id: string) {
	recoveryBusy.value[id] = true;
	recoveryBusyStart.value[id] = performance.now();
	if (!recoveryTickTimer) recoveryTickTimer = setInterval(() => { recoveryTick.value++; }, 250);
}
function endRecoveryBusy(id: string) {
	delete recoveryBusy.value[id];
	delete recoveryBusyStart.value[id];
	if (!Object.keys(recoveryBusy.value).length && recoveryTickTimer) { clearInterval(recoveryTickTimer); recoveryTickTimer = null; }
}

async function checkRecovery() {
	try {
		const res = await fetch(`${w.client.baseUrl}/recovery/check`);
		if (res.ok) {
			const data = await res.json();
			recoveryItems.value = data.incomplete || [];
		}
	} catch { /* backend unreachable */ }
}

// #48: the discard confirmation used to unconditionally say "this cannot be undone," which is
// simply wrong for a session that was also streamed to a remote backup server -- discarding the
// local copy here doesn't touch the remote one, so the data isn't actually gone. Checked
// alongside recovery rather than on every discard click so the dialog opens instantly; a session
// that finished streaming after this last ran would just get the more conservative (safe) wording.
const remoteBackupIds = ref<Set<string>>(new Set());
async function checkRemoteBackupIds() {
	try {
		const res = await fetch(`${w.client.baseUrl}/backup/remote-sessions`);
		if (res.ok) {
			const data = await res.json();
			remoteBackupIds.value = new Set((data.sessions || []).map((s: { id: string }) => s.id));
		}
	} catch { /* no backup server configured, or unreachable -- treat as "no known remote copy" */ }
}

// #49: a session that ends via a crash/force-quit never reaches workspace.ts's stop(), whose
// finally block is the only place that resets the amp out of MEASURE — so it's left integrating
// charge drift indefinitely until the next recording's start() happens to reset it first. Recover
// and discard are both "this session is conclusively over" points that stop() itself would have
// reset at, so both do the same best-effort reset here. Unconditional (not gated on the crashed
// session's own source) because RESET is a no-op-safe request even against a mock/idle amp, and
// we may not know what it recorded with without threading its manifest through.
// The .catch() also absorbs #33's /labamp/mode 409 in the (rare) case a DIFFERENT recording is
// genuinely live on this machine while an old crashed session is being cleaned up -- correctly a
// no-op then, since resetting the amp out from under that other live recording is exactly what
// #33 exists to prevent.
function resetAmpAfterRecoveryAction(): void {
	labamp.setMode('RESET').catch(() => {});
}

async function recoverSession(id: string) {
	beginRecoveryBusy(id);
	try {
		const res = await fetch(`${w.client.baseUrl}/recovery/recover/${id}`, { method: 'POST' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		recoveryItems.value = recoveryItems.value.filter((s) => s.id !== id);
		resetAmpAfterRecoveryAction();
	} catch (e: any) {
		alert(`Recovery failed: ${e?.message || e}`);
	} finally {
		endRecoveryBusy(id);
	}
}

async function discardSession(id: string) {
	const alsoRemote = remoteBackupIds.value.has(id);
	const ok = await confirmAction({
		title: 'Discard this incomplete recording?',
		message: alsoRemote
			? `The local copy of recording ${id} will be deleted. It was also streamed to the remote backup server, so it isn't gone for good — restore it from Settings > Remote Live Backup if you need it later.`
			: `Recording ${id} and its captured data will be deleted. This cannot be undone.`,
		detail: 'Recover it instead if you are not certain — an interrupted recording usually still holds usable data.',
		confirmLabel: 'Discard permanently',
		tone: 'danger',
	});
	if (!ok) return;
	beginRecoveryBusy(id);
	try {
		const res = await fetch(`${w.client.baseUrl}/recovery/discard/${id}`, { method: 'POST' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		recoveryItems.value = recoveryItems.value.filter((s) => s.id !== id);
		resetAmpAfterRecoveryAction();
	} catch (e: any) {
		alert(`Discard failed: ${e?.message || e}`);
	} finally {
		endRecoveryBusy(id);
	}
}

// Shared by the overlay banner and ackAlarm()'s confirm dialog below, so both ever say the same
// thing for the same alarm. A tacho alarm's value/threshold are always 0 (it's a signal-present
// check, not a magnitude) — falling through to the force branch's " N" suffix produced a
// nonsensical "cannot protect 0.0 N" banner that read as a misbehaving FORCE alarm even when
// force alarms were unticked and only the (separately-gated) RPM alarm's tacho check had fired.
function alarmValueText(al: { kind: string; value: number; threshold: number }): string {
	if (al.kind === 'tacho') return 'no signal';
	if (al.kind === 'rpm') return `${al.value.toFixed(0)} RPM`;
	if (al.kind === 'disk') return `${al.value.toFixed(1)} GB`;
	return `${al.value.toFixed(1)} N`;
}

// Silencing a tripped alarm is a safety-relevant action (it stops the tone/overlay for a real
// force/RPM/disk/tacho breach, not just a test) — a confirm gate prevents an accidental click while
// reaching for something else on the overlay from instantly clearing it. The prompt lists what
// actually tripped and the value that tripped it, so the decision is made against the measurements
// rather than a generic "are you sure?" the operator learns to dismiss reflexively.
async function ackAlarm() {
	// Snapshot both the display stats AND the keys being acknowledged synchronously, before the
	// await below — confirmAction() is a non-blocking DOM dialog (unlike the window.confirm() it
	// replaced, which blocked the whole renderer), so an alarm can fire while it's open. Passing
	// these specific `keys` to acknowledge() afterward means that new alarm — never shown here,
	// never consented to — stays tripped instead of being silently swept in.
	const tripped = w.alarms.active;
	const keys = tripped.map((al) => al.key);
	const ok = await confirmAction({
		title: tripped.length > 1 ? `Silence ${tripped.length} active alarms?` : 'Silence this alarm?',
		message: 'The tone stops and the banner clears. This does not fix the underlying condition, and the recording keeps running.',
		stats: tripped.map((al) => ({
			label: al.label,
			value: al.kind === 'tacho' ? 'no signal' : `${alarmValueText(al)} (limit ${alarmValueText({ ...al, value: al.threshold })})`,
		})),
		confirmLabel: 'Silence',
		cancelLabel: 'Keep alerting',
		tone: 'danger',
	});
	if (ok) w.alarms.acknowledge(keys);
}

// Tabbing/alt-tabbing away mid-replay used to leave the playhead running in the background
// (rAF still fires on a hidden tab, just throttled) — advancing invisibly so returning showed
// a jump, or on some setups the engine's own state got left inconsistent. Pause (not reset —
// the loaded cache and playhead position must survive) whenever the page goes out of view, and
// leave resuming to the user's own click rather than guessing they want it to keep going.
function onVisibilityChange() {
	if (document.hidden && w.mode.value === 'playback' && w.playback.state.playing) {
		w.playback.pause();
	}
}

// R10: keyboard shortcuts. One listener for the page's lifetime; shortcuts.ts decides what a key
// means, and each action calls what the matching button calls, so every gate still applies (pre-flight
// "Start anyway", the alarm test, the disk prompt, the sample-rate block, the silence confirmation).
function shortcutContext(): ShortcutContext {
	return {
		record: w.mode.value === 'record',
		// The Start / Stop buttons' own conditions (RecordingActions.vue), plus no save dialog in front.
		canStart: !w.locked.value && !w.startDisabled.value && !w.saveOpen.value,
		canStop: w.locked.value && !w.stopDisabled.value,
		alarmShowing: w.alarms.tripped,
		canNew: w.isDone.value && !w.saveOpen.value,
		saveDialogOpen: w.saveOpen.value,
		modalOpen: confirmState.current != null,
	};
}
function onShortcutKey(e: KeyboardEvent) {
	const t = e.target as (HTMLElement & { type?: string }) | null;
	const action = resolveShortcut({
		key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, isComposing: e.isComposing,
		target: t && { tagName: t.tagName, type: t.type, isContentEditable: t.isContentEditable },
	}, shortcutContext());
	if (!action) return;
	e.preventDefault(); // Ctrl+N would otherwise open a browser window
	if (action === 'start') void w.requestStart();
	else if (action === 'stop') void w.stop();
	else if (action === 'new') w.newRun();
	else if (action === 'acknowledge') void ackAlarm();
	else document.querySelector<HTMLButtonElement>('[data-save-primary]:not([disabled])')?.click();
}

onMounted(() => {
	window.addEventListener('keydown', onShortcutKey);
	// Reconcile with the recorder on entry and on every stream (re)open: a cut that ended while this
	// page was away, or a backend that restarted, is never announced over the stream (#2.1). The
	// stream also reconnects by itself, so a restart that leaves this route unchanged recovers too.
	w.client.onStreamOpen = () => { checkRecovery(); checkRemoteBackupIds(); checkBackup(); };
	w.acquireStream(); void w.client.reconcile(); startSync(); checkDisk(); checkRecovery(); checkRemoteBackupIds(); checkBackup();
	// ResizeObserver catches content reflow (a banner appearing/dismissing shifts the grid's top);
	// the window listener is the belt-and-braces fallback, since RO can fire unreliably under rapid
	// or programmatic viewport changes. Same pairing ForceDashboard uses.
	gridRO = new ResizeObserver(measureGrid);
	if (gridEl.value) gridRO.observe(gridEl.value);
	measureGrid();
	checkNarrow();
	window.addEventListener('resize', measureGrid);
	window.addEventListener('resize', checkNarrow);
	document.addEventListener('visibilitychange', onVisibilityChange);
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onShortcutKey);
	document.removeEventListener('visibilitychange', onVisibilityChange);
	w.client.onStreamOpen = null;
	w.releaseStream();  // keeps the socket while a cut runs (#185)
	// Suspend, never tear down: `w` is the app-lifetime workspace singleton (#25), so anything
	// destroyed here is destroyed for the rest of the session -- see PlaybackEngine.suspend().
	w.playback.suspend();
	diskGate.stop();
	preflightGate.stop();
	backupGate.stop();
	if (recoveryTickTimer) clearInterval(recoveryTickTimer);
	gridRO?.disconnect();
	window.removeEventListener('resize', measureGrid);
	window.removeEventListener('resize', checkNarrow);
	// These chips only make sense while the Record page (and its backend connection/polling) is
	// mounted — clear them so the sidebar doesn't show stale Record-page status on other routes.
	hwStatus.connected = false;
	hwStatus.diskFreeGb = -1;
	hwStatus.backupEnabled = false;
});
</script>

<template>
	<div class="rec-wrap" @click="addOpen = false">
		<!-- #26: disk-action and recovery banners used to sit in normal document flow (disk-action
			 was even "sticky", which still reserves flow space), pushing the grid down while shown and
			 lifting it back up when dismissed -- the .alarm-overlay below has always been a true
			 fixed-position overlay with zero flow impact, by contrast. This wrapper gives the other two
			 banners that same treatment: fixed, stacked in DOM order, never affecting the grid's layout.
			 #36's ResizeObserver-plus-explicit-watch fix stays in place regardless -- harmless if this
			 makes it a no-op remeasure, and still correct if any future banner goes back to flow. -->
		<div class="top-overlays">
			<!-- Disk-full protection: the backend watches free space during a recording independently of
				 this page's own polling, and reports what (if anything) it had to do about it. -->
			<div v-if="st.diskAction" class="disk-action-banner" :class="st.diskAction.action" role="status">
				<span class="material-symbols-rounded">{{ st.diskAction.action === 'forced_stop' ? 'dangerous' : st.diskAction.action === 'backup_started' ? 'cloud_upload' : 'warning' }}</span>
				<span v-if="st.diskAction.action === 'backup_started'">Disk space is low ({{ st.diskAction.freeGb.toFixed(1) }} GB free) — remote backup was switched on automatically to protect this recording.</span>
				<span v-else-if="st.diskAction.action === 'forced_stop'">Recording was stopped automatically — disk space ran critically low ({{ st.diskAction.freeGb.toFixed(1) }} GB free). The data captured so far is safe.</span>
				<span v-else>Disk space is low ({{ st.diskAction.freeGb.toFixed(1) }} GB free) and no remote backup is configured — free up space or configure a backup server soon.</span>
				<button class="btn sm inverse disk-action-ack" @click="st.diskAction = null">Dismiss</button>
			</div>

			<!-- R6: early warning. Amber, non-modal, silent: a force axis reached the warning share of the
				 limit. Not an alarm (nothing latches, nothing to acknowledge); Dismiss hides it for the cut. -->
			<div v-if="w.mode.value === 'record' && w.alarms.warnings.length" class="warn-banner" role="status" aria-live="polite" data-testid="force-warning">
				<span class="material-symbols-rounded">warning</span>
				<span>Approaching the force limit:
					<template v-for="(wn, i) in w.alarms.warnings" :key="wn.key">{{ i ? ', ' : ' ' }}{{ wn.axis }} {{ wn.value.toFixed(0) }} N</template>
					(warning at {{ w.alarms.warnLevel?.toFixed(0) }} N, alarm at {{ w.alarms.config.forceThreshold }} N)</span>
				<button class="btn sm inverse disk-action-ack" @click="w.alarms.dismissWarnings()">Dismiss</button>
			</div>

			<!-- R5: a sensor channel hit full scale this cut. Once per cut: Dismiss keeps it away until
				 the next one (workspace.ts railBanner). The red badges on the channel chips stay. -->
			<div v-if="w.railBanner.value" class="rail-banner" role="alert" data-testid="rail-banner">
				<span class="material-symbols-rounded">warning</span>
				<span>{{ w.railBanner.value }}</span>
				<button class="btn sm inverse disk-action-ack" @click="w.dismissRailBanner()">Dismiss</button>
			</div>

			<!-- Recovery banner for incomplete recordings found on startup -->
			<div v-if="recoveryBannerShown" class="recovery-banner">
				<div v-if="visibleRecoveryItems.length" class="rb-head">
					<span class="material-symbols-rounded">restore</span>
					<b>{{ visibleRecoveryItems.length }} incomplete recording{{ visibleRecoveryItems.length > 1 ? 's' : '' }} found</b>
					<span class="rb-hint">These recordings were interrupted by a crash or power failure. You can recover the data or discard them.</span>
				</div>
				<div v-for="s in visibleRecoveryItems" :key="s.id" class="rb-item">
					<div class="rb-info">
						<span class="rb-id" :title="s.id">{{ s.id }}</span>
						<span class="rb-detail" :title="`${s.raw.duration_sec.toFixed(1)}s · ${s.raw.n_rows.toLocaleString()} samples · ${s.raw.raw_size_mb} MB`">{{ s.raw.duration_sec.toFixed(1) }}s · {{ s.raw.n_rows.toLocaleString() }} samples · {{ s.raw.raw_size_mb }} MB</span>
						<span v-if="s.manifest?.config?.sample_name" class="rb-detail" :title="s.manifest.config.sample_name">{{ s.manifest.config.sample_name }}</span>
					</div>
					<button class="btn sm success" :disabled="!!recoveryBusy[s.id]" @click="recoverSession(s.id)">
						<span class="material-symbols-rounded" :class="{ spin: recoveryBusy[s.id] }">{{ recoveryBusy[s.id] ? 'progress_activity' : 'healing' }}</span>{{ recoveryBusy[s.id] ? `Recovering… ${recoveryElapsed(s.id).toFixed(0)}s` : 'Recover' }}
					</button>
					<button class="btn sm danger quiet" :disabled="!!recoveryBusy[s.id]" @click="discardSession(s.id)">
						<span class="material-symbols-rounded" :class="{ spin: recoveryBusy[s.id] }">{{ recoveryBusy[s.id] ? 'progress_activity' : 'delete' }}</span>{{ recoveryBusy[s.id] ? `Discarding… ${recoveryElapsed(s.id).toFixed(0)}s` : 'Discard' }}
					</button>
					<!-- #27: neither recovers nor discards -- just stops nagging about this one. The
						 capture stays on disk exactly as-is (still visible to the health-doctor's
						 "Crashed recordings" check if it's forgotten about entirely). -->
					<button v-if="dismissedRecoveryIds.has(s.id)" class="btn sm quiet" title="Ignored earlier — treat it like the others again" @click="unignoreRecovery(s.id)">
						<span class="material-symbols-rounded">visibility</span>Stop ignoring
					</button>
					<button v-else class="btn sm quiet" :disabled="!!recoveryBusy[s.id]" title="Deal with this later — stop showing it here, without recovering or discarding it" @click="dismissRecovery(s.id)">
						<span class="material-symbols-rounded">visibility_off</span>Ignore for now
					</button>
				</div>
				<!-- #83: the Connectivity doctor still counts ignored captures, so say how many there are. -->
				<div v-if="ignoredRecoveryCount" class="rb-ignored">
					<span>{{ ignoredRecoveryCount }} ignored incomplete recording{{ ignoredRecoveryCount > 1 ? 's' : '' }} (the Connectivity doctor still lists them).</span>
					<button class="btn sm quiet" @click="showIgnoredRecovery = !showIgnoredRecovery">{{ showIgnoredRecovery ? 'Hide ignored' : `Show ignored (${ignoredRecoveryCount})` }}</button>
				</div>
			</div>
		</div>

		<!-- Global safety-alarm overlay (2e): prominent, blocks nothing but demands acknowledgement. -->
		<div v-if="w.alarms.tripped" class="alarm-overlay" role="alert" aria-live="assertive">
			<span class="material-symbols-rounded">warning</span>
			<div class="ao-text">
				<b>SAFETY ALARM</b>
				<span v-for="al in w.alarms.active" :key="al.key" class="ao-item">{{ al.label }}{{ al.kind === 'tacho' ? '' : ' ' + alarmValueText(al) }}</span>
			</div>
			<button class="btn inverse primary ao-ack" @click="ackAlarm">Acknowledge</button>
		</div>

		<div ref="gridEl" class="gridwrap">
			<div class="panel-controls">
				<span class="rec-dot" :class="{ live: w.isRecording.value }" :title="w.st.state"></span>
				<div class="addwrap">
					<button class="btn icon reset" title="Add a panel" aria-label="Add a panel" @click.stop="addOpen = !addOpen"><span class="material-symbols-rounded">add</span></button>
					<div v-if="addOpen" class="addmenu up" @click.stop>
						<button v-for="a in addable" :key="a.type" :disabled="a.disabled" @click="addPanel(a.type)">
							<span class="material-symbols-rounded">{{ a.icon }}</span>{{ a.title }}<span v-if="a.disabled" class="added">added</span>
						</button>
					</div>
				</div>
				<button v-if="!narrow && hasType('options')" class="btn icon reset" title="Move the Recording &amp; Metadata panel to the other side" aria-label="Move Recording and Metadata panel to the other side" @click="moveOptionsPanel"><span class="material-symbols-rounded">swap_horiz</span></button>
				<button class="btn icon reset" title="Reset panel layout" aria-label="Reset panel layout" @click="resetLayout"><span class="material-symbols-rounded">grid_view</span></button>
			</div>
		<GridLayout v-model:layout="displayLayout" :col-num="narrow ? 1 : GRID_COLS" :row-height="rowHeight" :margin="[12, 12]"
			:is-draggable="!narrow" :is-resizable="!narrow" :use-css-transforms="true" :vertical-compact="true">
			<GridItem v-for="item in displayLayout" :key="item.i" :x="item.x" :y="item.y" :w="item.w" :h="item.h" :i="item.i"
				drag-allow-from=".panel-handle" :min-w="narrow ? 1 : 2" :min-h="3">
				<PanelFrame :title="PANEL_TYPES[item.type].title" :icon="PANEL_TYPES[item.type].icon" :dense="item.type === 'overview'"
					closable @close="closePanel(item.i)">
					<!-- A plot panel's title is its mode, so the header IS the mode picker: a title
						 reading "FFT" over a toolbar pill reading "FFT" said it twice. -->
					<template v-if="item.type === 'force'" #title>
						<PlotModeFlyout :model-value="item.mode ?? 'time'" :modes="PLOT_MODES"
							@update:model-value="item.mode = $event as PlotMode" />
					</template>
					<RecordingOptions v-if="item.type === 'options'" />
					<OverviewPanel v-else-if="item.type === 'overview'" />
					<ForcePanel v-else-if="item.type === 'force'" :inst="item" />
					<RpmPanel v-else-if="item.type === 'rpm'" />
					<FrmPanel v-else-if="item.type === 'frm'" />
					<PolarPanel v-else-if="item.type === 'polar'" />
					<template v-if="item.type === 'options'" #footer>
						<RecordingActions />
					</template>
				</PanelFrame>
			</GridItem>
		</GridLayout>
		</div>

		<SaveCutDialog v-if="w.saveOpen.value" />
	</div>
</template>

<style scoped>
/* display:flow-root is load-bearing (#51): .gridwrap's 8px top margin used to collapse straight
   through this wrapper, so .rec-wrap started 8px down the page while still claiming min-height
   100vh -- guaranteeing exactly 8px of overflow, and a scrollbar, on the default layout at every
   window size. A block formatting context keeps that margin inside. */
.rec-wrap { min-height: 100vh; display: flow-root; background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg)); padding-bottom: 24px; }
/* z-index 290: the topmost surface except the confirm prompt (300, launched from this banner's
   Acknowledge button) and the offline banner (App.vue, fixed top, 1000). It must sit above every
   dialog backdrop (save 200, edit-metadata 250, virtual-channel builder 260): stop-on-alarm opens
   the save dialog while the tone is still looping, and the operator has to be able to click
   Acknowledge. The offline banner would cover it, so `top` is pushed down by --offline-banner-h
   (App.vue publishes the measured banner height on <html> while offline, 0px otherwise): the
   offline banner stays the topmost strip and the alarm sits directly under it, both readable and
   both clickable. z-order.test.ts pins the ordering and the offset. */
.alarm-overlay { --banner: #dc2626; position: fixed; top: var(--offline-banner-h, 0px); left: 0; right: 0; z-index: 290; display: flex; align-items: center; gap: 14px; padding: 12px 20px;
	color: #fff; background: #dc2626; box-shadow: 0 6px 24px rgba(220,38,38,0.5); animation: alarmpulse 0.9s ease-in-out infinite; }
@keyframes alarmpulse { 0%,100% { background: #dc2626; } 50% { background: #991b1b; } }
.alarm-overlay > .material-symbols-rounded { font-size: var(--icon-2xl); }
.ao-text { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.ao-text b { font-size: var(--fs-lg); letter-spacing: 0.04em; }
.ao-item { font-size: var(--fs-md); font-variant-numeric: tabular-nums; background: rgba(0,0,0,0.2); padding: 2px 8px; border-radius: 6px; }
.ao-ack { margin-left: auto; }
.top-overlays { position: fixed; top: var(--offline-banner-h, 0px); left: 0; right: 0; z-index: 90; display: flex; flex-direction: column; max-height: 60vh; overflow-y: auto; }
.disk-action-banner { display: flex; align-items: center; gap: 12px; padding: 10px 18px; font-size: var(--fs-md); color: #fff; flex: none; }
.disk-action-banner.backup_started { background: #2563eb; }
.disk-action-banner.backup_unavailable { background: #b45309; }
.disk-action-banner.forced_stop { background: #dc2626; }
.disk-action-banner .material-symbols-rounded { font-size: var(--icon-lg); }
.disk-action-ack { margin-left: auto; }
.warn-banner { display: flex; align-items: center; gap: 12px; padding: 10px 18px; font-size: var(--fs-md); color: #fff; background: #b45309; flex: none; }
.warn-banner .material-symbols-rounded { font-size: var(--icon-lg); }
.rail-banner { display: flex; align-items: center; gap: 12px; padding: 10px 18px; font-size: var(--fs-md); color: #fff; background: #dc2626; flex: none; }
.rail-banner .material-symbols-rounded { font-size: var(--icon-lg); }
/* The shared icon button, see-through while it floats over the panels until pointed at. */
.reset { background: color-mix(in srgb, var(--surface) 55%, transparent); backdrop-filter: blur(4px); opacity: 0.72; transition: background-color 0.14s, opacity 0.14s; }
.reset:hover { opacity: 1; }
.panel-controls { position: fixed; right: 20px; bottom: 20px; z-index: 25; display: flex; align-items: center; gap: 8px; }
.addwrap { position: relative; }
.addmenu { position: absolute; top: 32px; right: 0; z-index: 30; min-width: 190px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; padding: 5px; box-shadow: 0 14px 40px rgba(0,0,0,0.3); }
.addmenu.up { top: auto; bottom: 32px; }
.addmenu button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 9px; font-size: var(--fs-md); color: var(--text); background: transparent; border: none; border-radius: 7px; cursor: pointer; text-align: left; }
.addmenu button:hover:not(:disabled) { background: var(--surface-2); }
.addmenu button:disabled { opacity: 0.45; cursor: default; }
.addmenu button .material-symbols-rounded { font-size: var(--icon-md); color: var(--text-dim); }
.addmenu .added { margin-left: auto; font-size: var(--fs-xs); color: var(--text-dim); }
.rec-dot { width: 9px; height: 9px; border-radius: 50%; background: #64748b; flex-shrink: 0; }
.rec-dot.live { background: #ef4444; animation: live-pulse 1.4s infinite; }
/* Recovery banner */
.recovery-banner { background: color-mix(in srgb, var(--bg-2) 95%, var(--warn) 5%); border-bottom: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); padding: 14px 18px; flex: none; box-shadow: 0 6px 20px rgba(0,0,0,0.25); }
.rb-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.rb-head > .material-symbols-rounded { font-size: var(--icon-xl); color: var(--warn); }
.rb-head b { font-size: var(--fs-lg); color: var(--text); }
.rb-ignored { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-dim); }
.rb-hint { font-size: var(--fs-sm); color: var(--text-dim); }
.rb-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; margin-bottom: 6px; }
.rb-info { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.rb-id, .rb-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rb-id { font-size: var(--fs-sm); font-weight: 600; font-family: var(--mono); color: var(--text); }
.rb-detail { font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
/* Wrapper exists purely so the responsive row-height maths has a real element to measure from
   (a ref on <GridLayout> would hand back the component instance, not a DOM node). */
.gridwrap { margin: 8px 10px 0; }
.vgl-layout { margin: 0; }
:deep(.vgl-item--placeholder) { background: color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 12px; }
:deep(.vgl-item__resizer) { z-index: 5; }
</style>
