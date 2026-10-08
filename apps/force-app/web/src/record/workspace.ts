// Shared state for the modular Recording workspace. Created once in RecordPage and provided to
// every panel via inject(), so panels stay small and independent while sharing one RecordClient,
// config, metadata, plot options, and the start/stop/replay actions.
import { computed, effectScope, inject, reactive, ref, shallowRef, watch, type InjectionKey } from 'vue';
import { shouldOpenSaveDialog } from './saveDialogGate';
import { RAW_BYTES_PER_SAMPLE, RAW_COLUMNS, RecordClient } from './liveClient';
import { api } from '../directusClient';
import { buildSeriesEnvelope, debouncePublish, parseCache, type Cache } from '@d1/force-plotting';
import { searchSamples, searchOperators, searchEquipment, searchTools, searchInserts, searchEdges, getMethods, resolveMachiningMethodId, type LookupItem } from './directusLookups';
import { logRun, syncStatus } from './directusSync';
import { alarmController } from './alarms';
import { recordingPrefs } from './recordingPrefs';
import { labamp, type AutoRangeRec } from './labampApi';
import { createPlaybackEngine } from './playback/engine';
import { loadPlotPrefs, savePlotPrefs, type PlotPrefs } from './plotPrefs';
import { clearSetupPrefs, defaultSetupPrefs, loadSetupPrefs, pickSetup, saveSetupPrefs, type SetupPrefs } from './setupPrefs';
import { analysisCreateFailure, directusErrorMessage, fetchCaptureBlobs, numOrNull, uploadCaptureFiles } from './uploadCapture';
import { adoptExistingAnalysis, analysisAlreadyLinked, ensureOperation, needsBlobs, uploadProgress } from './uploadResume';
import { OFFLINE_SESSION_UPLOAD_MESSAGE, currentRecorder, hasServerSession, ownerPersonId, recorderFields, resolveOwnerPersonId, syncerFields } from '../recorder';
import { isFetchFailure } from '../netErrors';
import { confirmAction } from '../ui/confirm';
import { spotlight } from '../ui/spotlight';
import { FIELD_FOCUS, StartRequestError, sampleRateIssue } from './recordingErrors';
import { nidaqHardware } from './nidaqHardware';
import { railBannerText } from './railing';
import { computePreflight, isCustomChannelList, needsSampleConfirm, parseChannelList, type AmpReading, type ChannelLike } from './preflight';
import { hwStatus } from './hwStatus';
import { nidaqApi } from '../nidaq/nidaqApi';
import { authStore } from '../authStore';
import { JSON_HEADERS, readJson } from '../recorderHttp';

export type Axis = 'Fx' | 'Fy' | 'Fz';

export interface ReplayOption {
	label: string; cacheId: string; opId: string; operationId: string | null;
	// From machining_force_analysis itself, not the linked operation — this is where the recorder
	// or the MATLAB ingestion pipeline actually stores a cut's true pulses-per-rev and diameters.
	// sampleRate is the TRUE acquisition rate; the cache's own Fs is decimated for a force-app cut
	// (finalize.py's fs_eff = fs/stride) and can read several times too low if used directly.
	ppr: number | null; outerDiam: number | null; innerDiam: number | null; sampleRate: number | null;
	// Human-saved crop start (seconds), from crop_start_idx_override ÷ sample_rate. When set it
	// overrides the cache's own auto-detected start-of-cut on replay (see the plotting-window
	// "Save crop as official" flow); null = play from the cache's detected csSec as before.
	cropStartSec: number | null;
}

// The "Operation type" select's values are short codes (MT-* = machining/turning, MM-* =
// machining/milling, 'other' = no category) — this is the single place that maps a code to the
// broad category used to filter Machine/Tool lookups and the replay cut list. Only turning/milling
// are distinguished since that's what the underlying equipment_type/tool_type free-text fields
// actually distinguish in practice (see directusLookups.ts).
export function opTypeCategory(opType: string): 'turning' | 'milling' | null {
	if (opType.startsWith('MT')) return 'turning';
	if (opType.startsWith('MM')) return 'milling';
	return null;
}

/** The Cut ID the Metadata panel shows and its "use" button copies into the pass code:
 *  {sample code}-{first two alphanumerics of the operation type, upper-case}{sequence}. */
export function composeCutId(
	link: { sampleLabel: string }, meta: Record<string, string>, machining: { operation_sequence: string },
): string {
	const code = (link.sampleLabel || meta.sample_code || meta.sample_name || '').trim();
	const type = (meta.op_type || '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 2);
	const seq = String(machining.operation_sequence ?? '').trim();
	return [code, `${type}${seq}`].filter(Boolean).join('-');
}

export function createWorkspace() {
	const client = new RecordClient();
	const SOURCE_LS_KEY = 'force-app.source';
	const storedSource = localStorage.getItem(SOURCE_LS_KEY);
	const source = ref<'sim' | 'replay' | 'nidaq'>(storedSource === 'sim' || storedSource === 'replay' || storedSource === 'nidaq' ? storedSource : 'sim');
	// Persist the user's explicit choice so the NI-DAQ auto-detect below (which re-runs on every
	// page mount, not just once ever) only ever applies a default the first time this browser has
	// been used — it must never silently override a choice the user already made. Without this, a
	// machine with real/simulated NI-DAQ hardware present forces source back to 'nidaq' on every
	// reload even after explicitly picking "Simulated". A plain `watch(source, ...)` isn't enough
	// on its own: source already defaults to 'sim', so clicking "Simulated" (same value) fires no
	// change event, and the auto-detect's fetch can still resolve afterward and overwrite it — so
	// setSource() below writes to localStorage unconditionally and synchronously, and the
	// auto-detect re-reads localStorage fresh (not a value captured before the click) right before
	// it would apply, closing the race regardless of which finishes first.
	// Replay and recording each keep their own copy of the form. A cut picked in Replay fills in
	// Sample/Machine/type, the per-cut fields and the insert/edge/tool picks for playback; none of
	// that may reach the next real cut, and the operator's setup must come back exactly as it was.
	// So entering Replay puts the recording form aside (and stores its setup half), and leaving it
	// puts the Replay form aside for the next visit (the loaded cut stays loaded) and brings the
	// recording form back from memory, which also survives a storage write that failed.
	interface FormCopy { setup: SetupPrefs; meta: Record<string, string>; machining: typeof machining; link: Record<string, string> }
	const PER_CUT_META = ['operation', 'notes', 'insert', 'edge_id', 'tool'] as const;
	const PER_CUT_LINK = ['insertId', 'insertLabel', 'edgeId', 'edgeLabel', 'toolId', 'toolLabel'] as const;
	let recordForm: FormCopy | null = null;
	let replayForm: FormCopy | null = null;
	function takeForm(): FormCopy {
		return {
			setup: snapshotSetup(),
			meta: Object.fromEntries(PER_CUT_META.map((k) => [k, meta[k] ?? ''])),
			machining: { ...machining },
			link: Object.fromEntries(PER_CUT_LINK.map((k) => [k, link[k]])),
		};
	}
	function putForm(f: FormCopy) {
		Object.assign(cfg, f.setup.cfg); Object.assign(link, f.setup.link);
		Object.assign(meta, f.setup.meta, f.meta);
		Object.assign(machining, f.setup.machining);
		const { operation_sequence, chips_ref, new_edge, chips_collected } = f.machining;
		Object.assign(machining, { operation_sequence, chips_ref, new_edge, chips_collected });
		Object.assign(link, f.link);
	}
	function setSource(s: 'sim' | 'replay' | 'nidaq') {
		const prev = source.value;
		if (s === 'replay' && prev !== 'replay') {
			// Store the setup as it is NOW, synchronously, and drop any pending push: the "don't save
			// in Replay" decision is made when a value is pushed (the setup watcher), not when the
			// debounce fires, so nothing pending can carry Replay state to storage later.
			recordForm = takeForm();
			setupSaver.cancel();
			saveSetupPrefs(recordForm.setup);
			if (replayForm && replay.cacheId) {
				putForm(replayForm);
			} else {
				// Entering Replay fresh (no cut loaded yet): Sample/Machine left over from the Sim/NI-DAQ
				// setup would otherwise silently AND-narrow searchCuts to that exact sample+machine and
				// return zero rows — "no matches" on every search, with no visible reason why.
				// CutPicker's own `change()` already clears this for a manual reselect.
				link.sampleId = ''; link.sampleLabel = '';
				link.equipmentId = ''; link.equipmentLabel = '';
				meta.op_type = '';
			}
		}
		source.value = s;
		try { localStorage.setItem(SOURCE_LS_KEY, s); } catch { /* blocked storage: the choice still holds for this session */ }
		if (prev === 'replay' && s !== 'replay') {
			replayForm = takeForm();
			if (recordForm) {
				putForm(recordForm);
			} else {
				// A launch straight into Replay has no recording form in memory: the stored setup,
				// with the per-cut fields and insert/edge/tool picks blank.
				restoreSetup(loadSetupPrefs());
				for (const k of PER_CUT_META) meta[k] = '';
				for (const k of PER_CUT_LINK) link[k] = '';
				Object.assign(machining, { operation_sequence: '', chips_ref: '', new_edge: false, chips_collected: false });
			}
			recordForm = null;
		}
	}
	const NIDAQ_LS_KEY = 'force-app.nidaq.channels';
	const defaultChannelList = ['cDAQ1Mod1/ai0', 'cDAQ1Mod1/ai1', 'cDAQ1Mod1/ai2', 'cDAQ1Mod1/ai3',
		'cDAQ1Mod2/ai0', 'cDAQ1Mod2/ai1', 'cDAQ1Mod2/ai2', 'cDAQ1Mod2/ai3', 'cDAQ1Mod3/ai0'];
	const defaultChannels = defaultChannelList.join('\n');
	const nidaqChannels = ref(localStorage.getItem(NIDAQ_LS_KEY) || defaultChannels);
	watch(nidaqChannels, (v) => localStorage.setItem(NIDAQ_LS_KEY, v));
	// What Start sends. The backend takes the NI-DAQ page's saved channel model unless this list is
	// empty or the default one, so only then does the model decide what records.
	// First-boot autoassign writes the saved model's own physical list here, which is never the
	// default on a real rig, so that list counts as the model too (preflight.ts isCustomChannelList).
	const customChannelList = computed(() => isCustomChannelList(nidaqChannels.value, defaultChannelList, preflightReads.channels));

	// The setup half of cfg/meta/machining/link is remembered across launches (R1, setupPrefs.ts) and
	// filled in by restoreSetup() below once `link` exists. `duration_sec` is not part of it: no
	// input edits it any more, it only feeds the pre-Start disk estimate.
	const cfg = reactive({
		rpm: 1200, feed: 0.05, diam: 80, inner_diam: 0,
		sample_rate: 25000, duration_sec: 8, ppr: 1,
	});
	// No default sample name: it used to be the fake 'SIM-CUT-001', which NI-DAQ recordings archived
	// as a real name. Empty is left out of the capture (metaObj), and the recorder falls back to its
	// own "SIM-CUT" label.
	const meta = reactive<Record<string, string>>({
		sample_name: '', sample_code: '', operation: '', op_type: '',
		insert: '', edge_id: '', coolant: '', notes: '',
	});
	// Extra machining fields mirroring the Directus manufacturing_operations form (folded section).
	const machining = reactive<{ axial_doc: string; radial_doc: string; cutting_length: string; coolant_pressure: string; operation_sequence: string; chips_ref: string; new_edge: boolean; chips_collected: boolean }>(
		{ axial_doc: '', radial_doc: '', cutting_length: '', coolant_pressure: '', operation_sequence: '', chips_ref: '', new_edge: false, chips_collected: false },
	);
	// Remembered across launches (#108), parsed defensively field by field (plotPrefs.ts).
	const plot = reactive<PlotPrefs>(loadPlotPrefs());
	// Written 250 ms after the last change, not on every slider tick; flushed when the page goes away.
	// The reactive object itself is pushed, so the write serialises whatever it holds by then.
	const plotSaver = debouncePublish<PlotPrefs>(savePlotPrefs, 250);
	watch(plot, () => plotSaver.push(plot), { deep: true });
	if (typeof window !== 'undefined') {
		window.addEventListener('pagehide', plotSaver.flush);
		window.addEventListener('beforeunload', plotSaver.flush);
	}
	// plot.windowSec is only the DEFAULT view window for force panels that have not set their own
	// (#34); it no longer limits the client's trace history (#105, see liveClient's retainSec).
	// `rpm`/`feed`/`diam` here describe the CUT BEING PLAYED. They deliberately do not live on
	// `cfg`: that is the config for the next real recording and is also serialised into the
	// Directus write-back by buildRunPayload(), so letting a replay overwrite it would silently
	// carry an archived cut's parameters — including the cache's already-DECIMATED sample rate —
	// into the next NI-DAQ capture and its logged record.
	// `rpm`/`feed`/`diam`/`ppr` describe the CUT BEING PLAYED — see the note on why they don't live
	// on `cfg` above `replay`'s declaration. `downloading` covers the asset fetch + parse in
	// pickReplayCut, separate from `loading` (the cut-search list), so the transport area can show
	// its own spinner while a (potentially large) cache is being fetched.
	const replay = reactive<{
		query: string; options: ReplayOption[]; cacheId: string; label: string; speed: number;
		loading: boolean; downloading: boolean;
		rpm: number; feed: number; diam: number; innerDiam: number; ppr: number; sampleRate: number;
	}>(
		{
			query: '', options: [], cacheId: '', label: '', speed: 1, loading: false, downloading: false,
			rpm: 0, feed: 0, diam: 0, innerDiam: 0, ppr: 1, sampleRate: 0,
		},
	);

	// Replaying an archived cut is PLAYBACK, not recording: a local playhead over a cut already in
	// the database, writing nothing to disk. Making the mode explicit (rather than testing
	// source.value === 'replay' at each site) keeps the "playback writes nothing" guarantee in one
	// auditable place.
	const mode = computed<'record' | 'playback'>(() => (source.value === 'replay' ? 'playback' : 'record'));
	const playback = createPlaybackEngine(client, { baseUrl: client.baseUrl });
	// Playback drives client.status itself ('recording' while it plays), so the recorder's own
	// state (RecordClient.reconcile, run on every stream (re)open) must not overwrite it.
	client.canReconcile = () => mode.value === 'record';
	// The RPM gauge's reference line: the replayed cut's own spindle speed in playback, the
	// configured target when recording. Panels read this rather than cfg.rpm directly.
	const rpmTarget = computed(() => (mode.value === 'playback' ? replay.rpm : cfg.rpm));
	watch(() => replay.speed, (s) => playback.setSpeed(s), { immediate: true });
	// FrmPanel's Fx/Fy/Fz toggle just sets plot.frmAxis — nothing else reacted to it during
	// playback, so the button's `on` state changed but the spiral's colour scale (cLo/cHi, set once
	// per axis at load()) never updated. LiveFrm.vue itself now recolours from the already-streamed
	// cx/cy/cz on any axis change (live and playback alike); this only keeps playback's percentile
	// colour scale in step with whichever axis is currently selected.
	watch(() => plot.frmAxis, (axis) => { if (mode.value === 'playback') playback.setAxis(axis); });

	const busy = ref(false);
	const errMsg = ref<string | null>(null);
	const finishedCache = shallowRef<Cache | null>(null);
	const st = client.status;
	const saveOpen = ref(false);
	// User-adjustable cut start/end for the end-of-cut save dialog, seeded from the cache's own
	// auto-detected csSec/ceSec once it loads (see loadFinished()). Only sent as an explicit
	// crop_start_idx_override/crop_end_idx_override on save when they differ from that detected
	// default — leaving them alone means "trust auto-detection", same as it always has.
	const editCutStartSec = ref<number | null>(null);
	const editCutEndSec = ref<number | null>(null);

	// Directus links for the run write-back (2d)
	const link = reactive({
		sampleId: '', sampleLabel: '', operatorId: '', operatorLabel: '',
		equipmentId: '', equipmentLabel: '', insertId: '', insertLabel: '',
		edgeId: '', edgeLabel: '', toolId: '', toolLabel: '',
	});
	const logged = ref(false);

	// Remembered setup (R1). Replay is the exception: setSource() clears Sample/Machine/Operation
	// type on entering it (they would AND-narrow the cut search to nothing), so a launch that opens
	// straight into Replay must not bring them back either, and nothing is written while in Replay
	// (the cleared or replay-hydrated values are not the operator's setup; the stored one stays for
	// the next Record launch). Leaving Replay restores the stored setup into the form.
	function restoreSetup(s: SetupPrefs) {
		Object.assign(cfg, s.cfg);
		Object.assign(machining, s.machining);
		Object.assign(meta, s.meta);
		Object.assign(link, s.link);
		if (source.value === 'replay') {
			link.sampleId = ''; link.sampleLabel = '';
			link.equipmentId = ''; link.equipmentLabel = '';
			meta.op_type = ''; meta.sample_name = ''; meta.sample_code = '';
		}
	}
	const snapshotSetup = () => pickSetup({ cfg, link, meta, machining });
	restoreSetup(loadSetupPrefs());
	// Same debounce/flush shape as plotSaver above. Whether to save is decided when a value is
	// PUSHED (never while in Replay), not when the debounce fires; setSource() stores the setup on
	// the way into Replay and restores it on the way out.
	const setupSaver = debouncePublish<SetupPrefs>(saveSetupPrefs, 250);
	watch([cfg, meta, machining, link], () => { if (source.value !== 'replay') setupSaver.push(snapshotSetup()); }, { deep: true });
	if (typeof window !== 'undefined') {
		window.addEventListener('pagehide', setupSaver.flush);
		window.addEventListener('beforeunload', setupSaver.flush);
	}
	// "Clear setup": every setup AND per-cut field back to its default, and the stored copy removed.
	function clearSetup() {
		restoreSetup(defaultSetupPrefs());
		meta.operation = ''; meta.notes = ''; meta.insert = ''; meta.edge_id = ''; meta.tool = '';
		machining.operation_sequence = ''; machining.chips_ref = '';
		machining.new_edge = false; machining.chips_collected = false;
		link.insertId = ''; link.insertLabel = ''; link.edgeId = ''; link.edgeLabel = ''; link.toolId = ''; link.toolLabel = '';
		recordForm = null;
		clearSetupPrefs();
	}

	// Safety alarms (2e) — the app-wide controller (config lives in Settings > Alarms), evaluated
	// here on every live frame while recording.
	const alarms = alarmController;
	// R6 (opt-in): a tripped force alarm stops the recording through the normal stop path, so the
	// save dialog and finalize behave exactly as after a manual Stop. The controller calls this once
	// per trip; the state check keeps a late call from stopping anything that is not recording.
	// The controller calls this once per trip, so a call that lands while start()/stop() holds `busy`
	// (stop() would return early) is remembered and retried when busy clears, or the trip's stop
	// would be lost for good. The retry re-checks the state, so a stop already under way is a no-op.
	let stopPendingOnTrip = false;
	alarms.onForceTrip = () => {
		if (mode.value !== 'record' || st.state !== 'recording') return;
		if (busy.value) { stopPendingOnTrip = true; return; }
		void stop();
	};
	watch(busy, (b) => {
		if (b || !stopPendingOnTrip) return;
		stopPendingOnTrip = false;
		if (mode.value === 'record' && st.state === 'recording') void stop();
	});
	// Record mode only: an archived cut must never trip a safety alarm on a machine that is not
	// cutting. Playback drove this with RPM that was also wrong by the decimation stride, so every
	// replay raised the full-screen overlay.
	watch(() => client.frameSeq.value, () => {
		if (mode.value === 'record' && st.state === 'recording') {
			alarms.evaluate(st.peaks, st.rpm, cfg.rpm);
			// Only meaningful on the real acquisition path: sim and replay synthesise their own
			// pulse train, and a source with no tacho hardware at all shouldn't raise a sensor fault.
			if (source.value === 'nidaq') alarms.evaluateTacho(st.tachoOk);
		}
	});

	// R4: pre-flight checklist for Start (preflight.ts). Its inputs are read here: the amp and the
	// saved channel list by refreshPreflight() (RecordPage polls it while waiting to Start), free
	// space from the Record page's disk poll via hwStatus, the rest straight from the form.
	const preflightReads = reactive<{ amp: AmpReading | null; channels: ChannelLike[] | null }>({ amp: null, channels: null });
	async function refreshPreflight() {
		if (source.value !== 'nidaq' || locked.value) return;
		const [amp, chans] = await Promise.allSettled([labamp.status(), nidaqApi.getChannels()]);
		// An unreadable amp or channel list is "not checked", never "failed": the recorder may just be
		// starting up, and Start has its own error path for a backend that really is down.
		preflightReads.amp = amp.status === 'fulfilled' ? { reachable: !!amp.value.reachable, mode: amp.value.mode ?? null, mock: !!amp.value.mock } : null;
		preflightReads.channels = chans.status === 'fulfilled' ? chans.value.channels : null;
	}
	const preflight = computed(() => computePreflight({
		source: source.value,
		sampleSet: !!link.sampleId,
		session: hasServerSession() ? 'server' : authStore.state.offline ? 'offline' : 'none',
		amp: preflightReads.amp,
		// The recorder measures the tacho only once samples flow, so there is nothing to report
		// before Start (st.tachoOk is last cut's value until the next one begins).
		tachoOk: null,
		diskFreeGb: hwStatus.diskFreeGb >= 0 ? hwStatus.diskFreeGb : null,
		sampleRate: cfg.sample_rate,
		channels: preflightReads.channels,
		channelsCustom: customChannelList.value,
	}));
	// A missing Sample is a warning, not a block: the first Start press shows "Start anyway".
	const sampleConfirmOpen = ref(false);
	watch(() => link.sampleId, (id) => { if (id) sampleConfirmOpen.value = false; });
	watch(source, () => { sampleConfirmOpen.value = false; });
	async function requestStart() {
		if (busy.value) return;
		if (needsSampleConfirm(preflight.value)) { sampleConfirmOpen.value = true; return; }
		await start();
	}
	async function startAnyway() {
		sampleConfirmOpen.value = false;
		await start();
	}

	// R5: the backend latches which sensor channels railed this cut (st.railed). The banner names
	// them once per cut: a dismissal is keyed on the capture it was made for, so adopting another
	// cut (a reconcile) shows that cut's banner, and it also resets when `railed` empties (New and
	// the next Start do that, via client.reset()). The badges on the channel tiles are not
	// dismissible, they stay for as long as the cut is on screen.
	const railDismissedFor = ref<string | null | undefined>(undefined);   // undefined = not dismissed
	watch(() => st.railed.length, (n) => { if (n === 0) railDismissedFor.value = undefined; });
	const railBanner = computed(() => (
		(railDismissedFor.value !== undefined && railDismissedFor.value === st.captureId) || mode.value !== 'record'
			? null : railBannerText(st.railed)
	));
	function dismissRailBanner() { railDismissedFor.value = st.captureId; }

	// Converging between-cuts auto-range: after each cut, recommend + apply the next-pass per-channel
	// ranges from THIS cut's recorded per-channel peaks (summary.channels_ranging). Applying them to
	// the amp is enough — the next nidaq run re-derives its N/V gains from the amp's ranges. Range
	// changes only ever happen here, between cuts, never mid-cut (which the charge amp can't do
	// cleanly). Clipped channels over-shoot upward and converge back down over the next pass or two.
	// `enabled` lives on recordingPrefs now (persisted, shared with Settings > Recording) — this
	// only keeps the session-transient state of an actual converge run.
	const converge = reactive<{ busy: boolean; status: string | null; recs: AutoRangeRec[] | null }>(
		{ busy: false, status: null, recs: null },
	);
	async function convergeAfterCut() {
		const cr = st.summary?.channels_ranging;
		if (!cr || !Array.isArray(cr.peaks_n)) { converge.status = 'no per-channel peaks in this capture'; return; }
		converge.busy = true;
		try {
			const res = await labamp.converge({ peaks: cr.peaks_n, clipped: cr.clipped, currents: cr.ranges_n, apply: true });
			converge.recs = res.recommendations;
			const clipped = res.recommendations.filter((r) => r.clipped).map((r) => r.channel);
			const over = Object.entries(res.status || {}).filter(([, s]) => s !== 'OK').map(([c]) => c);
			converge.status = clipped.length
				? `ranged up ch ${clipped.join(', ')} (railed) — set for next pass`
				: over.length ? `applied; ch ${over.join(', ')} still over-range` : 'ranges converged for next pass';
		} catch (e: any) {
			converge.status = `converge failed: ${e?.message || e}`;
		} finally { converge.busy = false; }
	}
	// Fire once per completed cut (covers both manual stop and self-terminating duration runs).
	watch(() => st.state, (s, prev) => { if (s === 'done' && prev !== 'done' && recordingPrefs.convergeEnabled) convergeAfterCut(); });

	function onSelectSample(it: LookupItem) {
		link.sampleLabel = it.label;
		meta.sample_name = it.label;
		meta.sample_code = it.label;
		const d = Number(it.extra?.diameter_mm);
		if (Number.isFinite(d) && d > 0) cfg.diam = d;  // auto-fill Ø from the sample
	}

	// Machine/Tool lookups narrow to whatever category the currently-selected Operation type
	// implies (turning/milling) — re-evaluated fresh on every keystroke, so changing Operation type
	// immediately re-scopes both without the user having to re-type their search.
	function searchEquipmentForOp(q: string) { return searchEquipment(q, opTypeCategory(meta.op_type)); }
	function searchToolsForOp(q: string) { return searchTools(q, opTypeCategory(meta.op_type)); }

	const isIdle = computed(() => st.state === 'idle');
	const isRecording = computed(() => st.state === 'recording');
	const isFinalizing = computed(() => st.state === 'finalizing');
	const isDone = computed(() => st.state === 'done');
	const locked = computed(() => isRecording.value || isFinalizing.value);
	// #185: leaving the Record page used to close the stream even mid-cut, so nothing arrived while
	// away and the trace joined old to new frames across the hole. The workspace owns the stream: the
	// page only acquires it on mount and releases it on unmount. While recording or finalizing a
	// release is deferred until the cut is no longer running; acquiring again cancels it, and
	// connect() keeps the socket it already has.
	let streamReleased = false;
	function acquireStream() { streamReleased = false; client.connect(); }
	function releaseStream() {
		if (locked.value) { streamReleased = true; return; }
		client.disconnect();
	}
	watch(locked, (l) => { if (!l && streamReleased) { streamReleased = false; client.disconnect(); } });
	// #84: why Start can't be pressed for the chosen NI-DAQ sample rate (the hardware can't do it), or
	// null. One computed for the footer's Start-disable and the red sample-rate tile, so they can't
	// disagree.
	const sampleRateBlocker = computed(() => (source.value === 'nidaq'
		? sampleRateIssue(cfg.sample_rate, nidaqHardware.maxRateHz)
		: null));
	// The footer's Start / Stop buttons are disabled when these are true; the R10 keyboard shortcuts
	// read the same two so a key can never do what the button can't.
	const startDisabled = computed(() => busy.value || !st.connected || !!sampleRateBlocker.value);
	const stopDisabled = computed(() => busy.value || isFinalizing.value);

	// The resolved Sample/Operator/Machine/Tool/Insert/Edge picks (`link.*`) and the folded
	// machining-details section (`machining.*`) used to reach Directus ONLY via buildRunPayload()'s
	// top-level columns, written at upload time — never persisted into extra_metadata at all. A
	// capture that wasn't uploaded immediately (saved locally, or a sample was never picked so
	// Upload wasn't even available) lost every resolved ID the moment the session ended: only the
	// free-text labels in `meta` survived to summary.json. `link_`-prefixed to stay unambiguous
	// against `meta.insert`/`meta.edge_id`, which are older free-text fields with a different
	// meaning. Found and fixed while building the capture metadata editor, which needs these to
	// pre-fill a correction with real lookups instead of starting from a blank search every time.
	// Who recorded this cut and when, fixed at Start (not at upload time -- the upload may happen
	// days later, offline first, under a different sign-in; see recorder.ts). Replay has no Start,
	// so it stamps lazily from whoever is signed in when the record is built.
	const recordedStamp = ref<Record<string, string | boolean> | null>(null);

	function metaObj(): Record<string, string | boolean> {
		const o: Record<string, string | boolean> = {};
		for (const [k, v] of Object.entries(meta)) if (v && v.trim()) o[k] = v.trim();
		const links: [string, string][] = [
			['link_sample_id', link.sampleId], ['link_sample_label', link.sampleLabel],
			['link_operator_id', link.operatorId], ['link_operator_label', link.operatorLabel],
			['link_equipment_id', link.equipmentId], ['link_equipment_label', link.equipmentLabel],
			['link_insert_id', link.insertId], ['link_insert_label', link.insertLabel],
			['link_edge_id', link.edgeId], ['link_edge_label', link.edgeLabel],
			['link_tool_id', link.toolId], ['link_tool_label', link.toolLabel],
		];
		for (const [k, v] of links) if (v) o[k] = v;
		for (const k of ['axial_doc', 'radial_doc', 'cutting_length', 'coolant_pressure', 'operation_sequence', 'chips_ref'] as const) {
			const v = machining[k];
			if (v && v.trim()) o[k] = v.trim();
		}
		o.new_edge = machining.new_edge;
		o.chips_collected = machining.chips_collected;
		Object.assign(o, recordedStamp.value ?? recorderFields(currentRecorder(), new Date().toISOString()));
		return o;
	}

	// Rough size estimate for the planned recording: raw float32 samples across all 10 columns
	// (Time + 8 dyno channels + Tacho), matching the backend's own estimate_recording_size_gb.
	// float32, NOT float64 — the raw writer emits dtype "<f4" (d1rw.py) and recovery.py reads
	// row_bytes = n_cols * 4. Assuming 8 bytes doubled every estimate, which tripped the
	// "not enough disk space" confirm below on runs that fit with room to spare.
	// Only meaningful when duration_sec reflects an actual plan — for real (nidaq) recordings it's
	// not enforced, just the number the user typed in as their target, which is exactly what's
	// needed here (and nowhere else currently uses it for nidaq).
	function estimatedRecordingGb(): number {
		return (cfg.sample_rate * cfg.duration_sec * RAW_COLUMNS * RAW_BYTES_PER_SAMPLE) / 1e9;
	}
	async function checkDiskBeforeStart(): Promise<boolean> {
		if (source.value === 'replay' || cfg.duration_sec <= 0) return true; // replay is short/bounded
		try {
			const res = await fetch(`${client.baseUrl}/storage/config`);
			if (!res.ok) return true; // can't check — don't block on it
			const info = await res.json();
			// free_gb is null when the backend could not stat the drive. Number(null) is 0, which
			// would read as "disk completely full" and prompt on every start — check for the null
			// explicitly and treat unknown as "can't check, don't block".
			if (info.free_gb == null) return true;
			const freeGb = Number(info.free_gb);
			if (!Number.isFinite(freeGb)) return true;
			const neededGb = estimatedRecordingGb();
			// Leave headroom: warn if the plan would eat into the last ~10% of what's free, not just
			// if it would exactly fill the disk — finalize() also needs room for capture.mat/live_cache.
			if (neededGb > freeGb * 0.9) {
				return await confirmAction({
					title: 'Not enough free disk space',
					message: 'The recording may be cut short if the drive fills up.',
					stats: [
						{ label: 'Planned run', value: `${cfg.duration_sec}s at ${cfg.sample_rate} Hz` },
						{ label: 'Estimated size', value: `${neededGb.toFixed(1)} GB` },
						{ label: 'Free space', value: `${freeGb.toFixed(1)} GB` },
					],
					confirmLabel: 'Record anyway',
					tone: 'warning',
				});
			}
			return true;
		} catch { return true; } // backend unreachable — the normal start() error path will explain that
	}

	// Gate the FIRST recording of the session (not every one — testedSinceStart is module-lifetime,
	// see alarms.ts) behind an offer to test the alarms, so an operator doesn't discover a dead
	// speaker/broken threshold only after a real breach goes unnoticed.
	async function checkAlarmsBeforeStart(): Promise<boolean> {
		if (source.value === 'replay') return true; // replay doesn't evaluate alarms
		if (alarms.testedSinceStart.value) return true;
		// An in-app dialog, not window.confirm(): the native one opened an OS dialog that Playwright's
		// CDP interception cannot see, so this gate had to be SKIPPED under FORCE_APP_TEST_HOOKS
		// rather than tested (commit d0b075c). A DOM dialog is a real button the e2e suite can click,
		// so the gate is now exercised the same way an operator meets it.
		if (await confirmAction({
			title: 'Test the alarms first?',
			message: 'Alarms have not been tested yet this session. A test fires the banner and tone so you can confirm you would actually notice them.',
			detail: 'Skipping is fine if you have already checked them on this machine today.',
			confirmLabel: 'Test alarms now',
			cancelLabel: 'Start without testing',
			tone: 'warning',
		})) {
			alarms.test();
			return false; // let the operator hear/see the test fire before starting
		}
		alarms.testedSinceStart.value = true; // don't nag again this session
		return true;
	}

	// The toggles that used to live directly on `cfg` — now sourced from recordingPrefs
	// (Settings > Recording) so a value set there actually reaches the next recording.
	//
	// `sample_name` belongs here too, even though it isn't a recordingPrefs field: RecordConfig has
	// its own top-level `sample_name` (Pydantic default "SIM-CUT"), completely separate from
	// `extra_metadata.sample_name`, and neither client.start() call ever sent it — every REAL
	// recording silently archived as "SIM-CUT" in summary.json/capture.mat regardless of which
	// sample was actually picked, with the true name buried one level down in extra_metadata. Found
	// while building the capture metadata editor, which needs a single correct source of truth for
	// this field to correct.
	function recordingPrefsPayload() {
		return {
			frm_from_cut: recordingPrefs.frmFromCut,
			drift_comp: recordingPrefs.driftComp,
			cut_detect_force: recordingPrefs.cutDetectForce,
			sample_name: meta.sample_name || undefined,
		};
	}

	async function start() {
		if (busy.value) return;
		// Held across the pre-flight prompts and fetches too (not only the request itself): a
		// double-click used to start a second start() while the first waited on them, which reset
		// state under the first and then got a 409 (review 2.5). Cleared in the finally below.
		busy.value = true;
		cancelAmpReset?.();
		try {
			if (!(await checkAlarmsBeforeStart())) return;
			if (!(await checkDiskBeforeStart())) return;
			errMsg.value = null; finishedCache.value = null;
			alarms.reset();
			// Replay is played, not recorded (it throws below): it keeps stamping lazily in metaObj().
			if (source.value !== 'replay') recordedStamp.value = recorderFields(currentRecorder(), new Date().toISOString());
			if (source.value === 'replay') {
				// Playback is driven by the transport bar, not by start(). Reaching here means a
				// caller bypassed the mode switch.
				throw new Error('replay is played, not recorded — use the transport controls');
			} else if (source.value === 'nidaq') {
				// Reset the charge amplifier before each cut (clears accumulated charge drift).
				try {
					await labamp.setMode('RESET');
					await new Promise((r) => setTimeout(r, 500));
					await labamp.setMode('MEASURE');
				} catch { /* amp unreachable — proceed anyway, gains were set at last range */ }
				const chans = parseChannelList(nidaqChannels.value);
				await client.start({ ...cfg, ...recordingPrefsPayload(), source: 'nidaq', nidaq_channels: chans, axis: plot.frmAxis, extra_metadata: metaObj() } as any);
			} else {
				await client.start({ ...cfg, ...recordingPrefsPayload(), source: 'sim', axis: plot.frmAxis, extra_metadata: metaObj() } as any);
			}
		} catch (e: any) {
			const m = e?.message || 'failed to start';
			// A bare "Failed to fetch"/"Load failed" is a transport failure reaching the recorder
			// (backend down, or blocked by CORS / HTTPS mixed-content) — spell that out.
			errMsg.value = isFetchFailure(m)
				? `${m} — can't reach the recording backend. Is it running on this machine?`
				: m;
			// #84: the backend named the field it refused (e.g. a sample rate above the hardware's
			// maximum) — point at it rather than leaving the operator to find it.
			const focusId = e instanceof StartRequestError && e.detail.field ? FIELD_FOCUS[e.detail.field] : undefined;
			if (focusId) spotlight(focusId);
		} finally {
			busy.value = false;
		}
	}

	async function stop() {
		if (busy.value) return;
		busy.value = true;
		// Open the save dialog the instant Stop is pressed (not once finalize finishes) — it shows a
		// loading state until st.state reaches 'done', so the user gets immediate feedback instead of
		// an interactive-looking-but-actually-stopped UI during the finalize gap.
		saveOpen.value = true;
		try {
			try {
				await client.stop();
			} catch (e: any) {
				// The stop did not go through. Ask the recorder what is really happening: if the cut
				// already ended on its own (auto-stop, disk-full) carry on into the save flow; if it
				// is still running, or unreachable, say so and drop the dialog (it would only spin).
				await client.reconcile().catch(() => {});
				if (st.state === 'recording' || st.state === 'idle') {
					saveOpen.value = false;
					errMsg.value = `could not stop the recording - ${e?.message || e}`;
					return;
				}
			}
			await loadFinished();
		} finally {
			busy.value = false;
			if (source.value === 'nidaq') resetAmpWhenSettled();
		}
	}

	// The amp should only ever be in MEASURE while a cut is actually running — left in MEASURE
	// between cuts it keeps integrating charge drift for no reason. The recorder refuses amp writes
	// (409) while it is busy, and that includes `finalizing`, which can last a long time on a big
	// cut: so RESET goes out once the run has settled (done/error), not right after the stop
	// request. Best-effort — an unreachable amp must not block the UI. A new recording starting
	// meanwhile (or a different capture) cancels it: start() does its own RESET -> MEASURE.
	let cancelAmpReset: (() => void) | null = null;
	function resetAmpWhenSettled() {
		cancelAmpReset?.();
		const sendReset = () => { labamp.setMode('RESET').catch(() => {}); };
		const state = st.state;
		if (state === 'recording') return;                 // the stop did not take: still running
		if (state !== 'finalizing') { sendReset(); return; }
		const id = st.captureId;
		const stopWatch = watch(() => [st.state, st.captureId] as const, ([s, cid]) => {
			if (s === 'finalizing' && cid === id) return;
			cancelAmpReset?.();
			if (cid === id && (s === 'done' || s === 'error')) sendReset();
		}, { flush: 'sync' });
		cancelAmpReset = () => { stopWatch(); cancelAmpReset = null; };
	}

	async function loadFinished() {
		const id = st.captureId;
		if (!id) return;
		// finalize() writes live_cache.bin before it ever publishes state=done, so by the time this
		// is called the file is already complete on disk - a failure here is a transient network
		// hiccup, not missing data. Retry a few times before giving up, so the save dialog's "loading
		// trace" spinner doesn't turn into a false "no data" state on the first blip.
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				const res = await fetch(client.cacheUrl(id));
				if (res.ok) {
					const cache = parseCache(await res.arrayBuffer());
					finishedCache.value = cache;
					editCutStartSec.value = cache.csSec;
					editCutEndSec.value = cache.ceSec;
					return;
				}
			} catch { /* retry */ }
			if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
		}
	}

	// `nextCut` is false when the finished cut is being DISCARDED: nothing was kept, so the retake
	// is the same cut and its sequence number / chips / new-edge flag stay as they were.
	function newRun(nextCut = true) {
		client.reset(); finishedCache.value = null; errMsg.value = null; logged.value = false; saveOpen.value = false;
		recordedStamp.value = null;
		editCutStartSec.value = null; editCutEndSec.value = null;
		// The early-warning banner belongs to the cut that just ended. Warnings only: reset() would
		// also clear an alarm the operator has not acknowledged.
		alarms.resetWarnings();
		if (!nextCut) return;
		// R3: the next cut is a new pass. Step the sequence when it is a whole number (a blank or
		// free-text one is left alone), so the Cut ID {sample}-{TYPE}{seq} does not repeat, and drop
		// the previous cut's chips and new-edge marks. Free-text pass codes are not touched.
		// A pass code that is just the auto-composed Cut ID (the Metadata panel's "use" button) belongs
		// to the cut that just ended, so it is cleared and the panel composes the next one; free text
		// the operator typed is left alone.
		if (meta.operation.trim() && meta.operation.trim() === composeCutId(link, meta, machining)) meta.operation = '';
		const seq = machining.operation_sequence.trim();
		if (/^\d+$/.test(seq)) machining.operation_sequence = String(Number(seq) + 1);
		machining.chips_ref = ''; machining.chips_collected = false; machining.new_edge = false;
	}

	// The save dialog's failed state: Close and "Show me the setting" land here. A start that captured
	// nothing is retaken as the same cut, so the sequence and per-cut marks stay, like a discard. An
	// acquisition or finalize failure that kept the raw (`rawKept`) was a real pass, recoverable from
	// Local Captures under this sequence number, so the next cut steps on as after a save.
	function dismissFailure(rawKept: boolean) { saveOpen.value = false; newRun(rawKept); }

	// End-of-cut save/upload: pushes the manufacturing_operations row (bypassing the offline queue,
	// since we need its operation_id back synchronously to link machining_force_analysis), then
	// uploads the capture.mat + live_cache.bin as Directus files and links them into a new
	// machining_force_analysis row. Throws on failure (offline, validation, etc) so the save dialog
	// can surface the error and let the user retry or fall back to a local-only save.
	async function logRunSync(): Promise<string> {
		if (!hasServerSession()) throw new Error(OFFLINE_SESSION_UPLOAD_MESSAGE);
		const payload = buildRunPayload();
		payload.method_id = await resolveMachiningMethodId(meta.op_type).catch(() => null);
		payload.recorded_metadata = { ...payload.recorded_metadata, ...syncerFields() };
		if (payload.owner_person_id == null) payload.owner_person_id = await resolveOwnerPersonId(payload.recorded_metadata);
		let res;
		try {
			res = await api.post('/items/manufacturing_operations', payload);
		} catch (e: any) {
			throw new Error(`logging the run failed - ${directusErrorMessage(e)}`);
		}
		const opId = res.data?.data?.operation_id;
		if (!opId) {
			// The insert reported success but didn't hand back the new row's id (e.g. a field
			// permission hiding operation_id on the response) - without it we can't link
			// machining_force_analysis, so fail loudly here rather than inserting a row with a
			// silently-missing FK (which is what was producing the opaque 500 further down).
			throw new Error('run was logged but the server did not return its operation_id - cannot link the capture');
		}
		logged.value = true;
		return opId;
	}
	// The crop the operator set in the final summary, as full-rate sample indices. Null unless a
	// handle was actually moved: untouched, auto-detection keeps deciding. Both sides or neither.
	function cropOverrideIdx(): { start: number; end: number } | null {
		const cache = finishedCache.value;
		const s = editCutStartSec.value, e = editCutEndSec.value;
		if (!cache || s == null || e == null || (s === cache.csSec && e === cache.ceSec)) return null;
		const fs = captureFs();
		return { start: Math.round(s * fs), end: Math.round(e * fs) };
	}
	// The cut's own rate from its summary: the form's rate can differ (an adopted cut, an edit after
	// the cut, NI-DAQ coercion), and the backend checks the indices against summary.n.
	function captureFs(): number { return Number(st.summary?.fs) || cfg.sample_rate; }
	// #190: the edited crop used to live only in memory and in the Directus POST, so a failed upload
	// (or a restart) lost it. Writing it to the capture's summary.json first means the local plot,
	// a retry from Local Captures and a cold start all still have it. Best effort and never throws:
	// an unreachable recorder must not block saving the files or the upload. Called once, by the
	// save dialog, before anything that can fail; the PUT is idempotent.
	async function saveCropLocally(): Promise<void> {
		const id = st.captureId;
		if (!id) return;
		// Untouched handles PUT nulls, which clears an override an earlier (failed) save stored.
		const crop = cropOverrideIdx();
		try {
			await readJson(await fetch(`${client.baseUrl}/captures/${id}/crop`, {
				method: 'PUT',
				headers: JSON_HEADERS,
				body: JSON.stringify({ crop_start_idx_override: crop?.start ?? null, crop_end_idx_override: crop?.end ?? null }),
			}));
		} catch (e) { console.warn('could not save the crop to the capture folder', e); }   // best effort
	}
	async function uploadCutToDatabase(): Promise<string> {
		const id = st.captureId;
		if (!id) throw new Error('no capture id for this recording');
		if (!hasServerSession()) throw new Error(OFFLINE_SESSION_UPLOAD_MESSAGE);
		// Resume (review 2.2): a retry after a failed file upload or analysis insert continues from
		// what the earlier attempt finished instead of inserting a second operation row.
		const progress = uploadProgress(id);
		if (progress.analysisDone && progress.opId) return progress.opId;
		// A null summary (the summary fetch failed during a reconcile) is not "a .mat was written":
		// an over-MAT_MAX_BYTES cut has none. Ask the recorder before deciding. 404 = no
		// summary.json at all (an old capture): treat as before. Any other failure is a retryable
		// error, not a guess.
		if (!st.summary) {
			let r: Response;
			try { r = await fetch(`${client.baseUrl}/captures/${id}/summary`); }
			catch { throw new Error('could not read the capture summary from the recorder - try again'); }
			if (r.ok) st.summary = await r.json();
			else if (r.status !== 404) throw new Error(`could not read the capture summary from the recorder (${r.status}) - try again`);
		}
		const matWritten = st.summary?.mat_written !== false;
		// The local blob reads don't need the logged run, so they start alongside it; the uploads
		// still wait for it, so a failed insert never leaves orphaned files -- and cancels the reads.
		// Without a capture.mat (over MAT_MAX_BYTES) the analysis record is still fully usable from
		// the decimated cache; directus_files_id just goes in as null.
		const blobReads = new AbortController();
		let blobs = needsBlobs(progress, matWritten)
			? fetchCaptureBlobs(client.matUrl(id), client.cacheUrl(id), matWritten, blobReads.signal)
			: null;
		blobs?.catch(() => {});   // surfaced by the await below, not as an unhandled rejection
		let opId: string;
		let existing: boolean;
		try {
			({ opId, existing } = await ensureOperation(id, progress, logRunSync));
			logged.value = true;
		} catch (e) {
			blobReads.abort();
			throw e;
		}
		// An existing analysis row may already link some files: don't upload those again.
		await adoptExistingAnalysis(progress, opId, existing);
		if (blobs && !needsBlobs(progress, matWritten)) { blobReads.abort(); blobs = null; }
		if (blobs) {
			const [matBlob, cacheBlob] = await blobs;
			await uploadCaptureFiles(id, matBlob, cacheBlob, progress);
		}
		try {
			// Completes an existing but partial analysis row (PATCH of the missing links), else false.
			if (await analysisAlreadyLinked(progress)) return opId;
		} catch (e: any) {
			throw new Error(`linking the capture failed - ${directusErrorMessage(e)} (the run was logged as operation ${opId}, but its existing analysis record could not be completed)`);
		}
		const matFileId = progress.matFileId ?? null;
		const cacheFileId = progress.cacheFileId!;
		const peaks = st.summary?.peaks;
		// ForceDashboard's chart reads its plot data from `series` (a JSONB min/max envelope), not
		// from live_cache_file — without this, upload "succeeds" (peaks/FRM all show up fine) but
		// the force/RPM charts render "no data" forever, since series is otherwise left null.
		const cache = finishedCache.value;
		const series = cache ? buildSeriesEnvelope(cache) : null;
		// Only an explicit override when the operator actually moved a handle in the save dialog:
		// untouched, auto-detection keeps deciding.
		const crop = cropOverrideIdx();
		try {
		await api.post('/items/machining_force_analysis', {
			operation_id: opId,
			directus_files_id: matFileId,
			live_cache_file: cacheFileId,
			status: 'done',
			sample_rate: captureFs(),
			feed: cfg.feed,
			cut_diameter: cfg.diam,
			max_rpm: cfg.rpm,
			peak_fx: peaks?.Fx ?? null,
			peak_fy: peaks?.Fy ?? null,
			peak_fz: peaks?.Fz ?? null,
			series,
			...(crop ? { crop_start_idx_override: crop.start, crop_end_idx_override: crop.end } : {}),
			matlab_version: 'force-app-direct',
			processed_at: new Date().toISOString(),
		});
		progress.analysisDone = true;
		} catch (e: any) {
			throw analysisCreateFailure(e, opId, matWritten);
		}
		return opId;
	}

	// Build + enqueue the manufacturing_operations run record (offline-queued in directusSync).
	function buildRunPayload(): Record<string, any> {
		const surface = Math.PI * cfg.diam * cfg.rpm / 1000;
		const extra = metaObj();
		return {
			// The recorder's person, not whoever's token performs the write (see recorder.ts).
			owner_person_id: ownerPersonId(extra) ?? null,
			sample_id: link.sampleId || null,
			operator_person_id: link.operatorId || null,
			equipment_id: link.equipmentId || null,
			insert_edge_id: link.edgeId || null,
			tool_id: link.toolId || null,
			operation_date: String(extra.recorded_at || new Date().toISOString()),
			process_category: 'machining',
			machining_operation_subtype: meta.op_type || null,
			machining_spindle_speed_rpm: cfg.rpm,
			machining_feed_mm_per_rev: cfg.feed,
			machining_workpiece_diameter_mm: cfg.diam,
			machining_cutting_speed_m_per_min: Number(surface.toFixed(2)),
			machining_force_captured: true,
			machining_tacho_used: true,
			machining_coolant_used: !!(meta.coolant && meta.coolant.trim()),
			capture_software: 'force-app',
			capture_frequency_khz: Number((captureFs() / 1000).toFixed(3)),
			outcome_notes: meta.notes || null,
			// Machining details (folded Directus form section)
			machining_axial_depth_of_cut_mm: numOrNull(machining.axial_doc),
			machining_radial_depth_of_cut_mm: numOrNull(machining.radial_doc),
			machining_cutting_length_mm: numOrNull(machining.cutting_length),
			machining_coolant_pressure_bar: numOrNull(machining.coolant_pressure),
			operation_sequence: numOrNull(machining.operation_sequence),
			machining_new_edge: machining.new_edge,
			machining_chips_collected: machining.chips_collected,
			machining_chips_ref_code: machining.chips_ref || null,
			recorded_metadata: {
				...extra, capture_id: st.captureId, peaks: st.summary?.peaks,
				source: source.value, replay_of: source.value === 'replay' ? replay.label : undefined,
			},
		};
	}
	async function logRunNow(): Promise<void> {
		const payload = buildRunPayload();
		// method_id is required on manufacturing_operations; resolve from the cached method list
		// (warmed at load, so this works even offline).
		payload.method_id = await resolveMachiningMethodId(meta.op_type).catch(() => null);
		await logRun(payload);
		logged.value = true;
	}

	// Warm the methods cache so the required method_id resolves even if we're offline at log time.
	getMethods().catch(() => {});

	// Auto-detect NI-DAQ hardware and switch source + channels if real devices are present — but
	// only ever as a first-run default. Re-checks localStorage fresh (not the `storedSource` value
	// captured above at workspace-creation time) immediately before applying, so a source picked
	// while this fetch was in flight always wins no matter which finishes first.
	(async () => {
		if (storedSource) return;
		try {
			const res = await fetch(`${client.baseUrl}/nidaq/devices`);
			if (!res.ok) return;
			const devs = await res.json();
			if (localStorage.getItem(SOURCE_LS_KEY)) return; // user chose explicitly while this was in flight
			if (!devs.simulated && devs.chassis?.length) {
				setSource('nidaq');
				// The amp should sit in RESET whenever we're not actively recording — cover the
				// "just found real hardware at app boot" case too, not only after a cut ends.
				labamp.setMode('RESET').catch(() => {});
				const ar = await fetch(`${client.baseUrl}/nidaq/channels/autoassign`, { method: 'POST' });
				if (ar.ok) {
					const data = await ar.json();
					const detected = (data.channels || []).map((c: any) => c.physical).join('\n');
					nidaqChannels.value = detected;
					localStorage.setItem(NIDAQ_LS_KEY, detected);
				}
			}
		} catch { /* backend unreachable — stay on sim */ }
	})();

	// Directus-backed cut picker for replay. Only `operation_id.pass_code` is set by the
	// MATLAB/crawler ingestion pipeline — a cut recorded and uploaded directly through force-app
	// (uploadCutToDatabase) never gets a pass_code, so it was both unsearchable (pass_code-only
	// filter can't match null) and effectively invisible in the unfiltered list (sorted by
	// pass_code, nulls last, past the 25-row limit) — i.e. "replay my last recording" could never
	// find a force-app-made recording at all. Fixed by also matching the linked sample's
	// code/nickname, and sorting by recency (this row's own created_at) instead of pass_code, so
	// the most recent recording — pass_code or not — is what shows up first with no search needed.
	// Also progressively narrowed by whatever Sample/Operation type/Machine are currently picked in
	// the metadata section above (all optional, AND-ed together) — so filling those in before
	// searching narrows straight to "operations on this sample, this type, this machine" instead of
	// free-text search being the only way in. Re-run (see the watch in RecordingOptions.vue)
	// whenever any of those three change while in replay mode.
	// Flipped off the first time Directus rejects crop_start_idx_override (pre-migration); see below.
	let cropFieldAvailable = true;
	// Request tokens (review 2.7): searches fire per keystroke and per Sample/Machine/Operation-type
	// change, and replies can arrive out of order. Only the latest call may write its result; a
	// source switch also supersedes whatever is in flight (below).
	let searchSeq = 0;
	let pickSeq = 0;
	watch(source, () => {
		searchSeq++; pickSeq++;
		replay.loading = false; replay.downloading = false;
	}, { flush: 'sync' });
	async function searchCuts(q: string) {
		const my = ++searchSeq;
		replay.loading = true;
		try {
			const filter: any = { status: { _eq: 'done' }, live_cache_file: { _nnull: true } };
			const and: any[] = [];
			if (q && q.trim()) {
				const query = q.trim();
				and.push({ _or: [
					{ operation_id: { pass_code: { _icontains: query } } },
					{ operation_id: { sample_id: { sample_code: { _icontains: query } } } },
					{ operation_id: { sample_id: { nickname: { _icontains: query } } } },
				] });
			}
			if (link.sampleId) and.push({ operation_id: { sample_id: { _eq: link.sampleId } } });
			if (link.equipmentId) and.push({ operation_id: { equipment_id: { _eq: link.equipmentId } } });
			const category = opTypeCategory(meta.op_type);
			if (category) and.push({ operation_id: { machining_operation_subtype: { _starts_with: category === 'turning' ? 'MT' : 'MM' } } });
			if (and.length) filter._and = and;
			const baseFields = ['id', 'live_cache_file', 'created_at', 'pulses_per_rev', 'outer_diameter', 'inner_diameter', 'sample_rate',
				'operation_id.operation_id', 'operation_id.pass_code',
				'operation_id.sample_id.sample_code', 'operation_id.sample_id.nickname'];
			// crop_start_idx_override arrives with migration 20260828000103. Until that's applied the
			// column doesn't exist and Directus 400s the whole query on the unknown field — which would
			// break replay search entirely. So request it optimistically and, if it's rejected, drop it
			// and retry: search keeps working pre-migration, and the crop override auto-activates the
			// moment the column exists, with no code change.
			const params: any = { filter, limit: 25, sort: '-created_at',
				fields: cropFieldAvailable ? [...baseFields, 'crop_start_idx_override'] : baseFields };
			let res;
			try {
				res = await api.get('/items/machining_force_analysis', { params });
			} catch (e: any) {
				if (cropFieldAvailable && e?.response?.status === 400) {
					cropFieldAvailable = false;
					res = await api.get('/items/machining_force_analysis', { params: { ...params, fields: baseFields } });
				} else { throw e; }
			}
			if (my !== searchSeq) return;   // superseded while the request was out
			replay.options = (res.data?.data ?? []).map((r: any) => ({
				label: r.operation_id?.pass_code || r.operation_id?.sample_id?.sample_code || r.operation_id?.sample_id?.nickname || r.id,
				cacheId: r.live_cache_file, opId: r.id, operationId: r.operation_id?.operation_id ?? null,
				ppr: r.pulses_per_rev != null ? Number(r.pulses_per_rev) : null,
				outerDiam: r.outer_diameter != null ? Number(r.outer_diameter) : null,
				innerDiam: r.inner_diameter != null ? Number(r.inner_diameter) : null,
				sampleRate: r.sample_rate != null ? Number(r.sample_rate) : null,
				cropStartSec: (r.crop_start_idx_override != null && r.sample_rate) ? Number(r.crop_start_idx_override) / Number(r.sample_rate) : null,
			})).filter((o: ReplayOption) => o.cacheId);
		} catch {
			if (my === searchSeq) replay.options = [];
		} finally {
			if (my === searchSeq) replay.loading = false;
		}
	}

	// Picking a cut to replay loads that operation's FULL original metadata into the same fields a
	// live/sim recording would use — previously only the sample name got copied, so "rerun a past
	// recording" left every other field (operator, machine, tool, insert/edge, machining params)
	// blank even though the original operation had them all recorded.
	async function pickReplayCut(o: ReplayOption) {
		const my = ++pickSeq;   // a newer pick, or a switch of source, supersedes this one
		errMsg.value = null;
		replay.downloading = true;
		// Parse the cut locally and hand it to the playhead. No backend session is opened and
		// nothing is written to disk — playback is a viewer over a cut already in the database.
		//
		// Nothing in `replay`/`machining` is written until this succeeds: committing the NEW cut's
		// identity (cacheId/label) up front, before the download can actually fail, used to leave
		// the picker showing cut B's label while the transport kept playing cut A's data — the
		// pick and the load could disagree. A failed download now leaves the previous cut (identity
		// AND its metadata below) exactly as it was; errMsg reports the failure.
		let c;
		try {
			const res = await api.get(`/assets/${o.cacheId}`, { responseType: 'arraybuffer' });
			c = parseCache(res.data as ArrayBuffer);
		} catch (e: any) {
			if (my !== pickSeq) return;
			errMsg.value = `could not load that cut — ${e?.message || e}`;
			replay.downloading = false;
			return;
		}
		// Late result of a superseded pick: loading it would reset the live client and playhead under
		// whatever the operator chose since (e.g. after switching to Sim).
		if (my !== pickSeq) return;
		// PPR (and diameters) come from the cut's own machining_force_analysis row, fetched
		// alongside it in searchCuts — NOT from cfg.ppr, which is the recording form's value and
		// has no relation to how this cut was actually recorded. Getting this wrong doesn't just
		// look slightly off: the FRM spiral's radius is r = revs/ppr, so a wrong ppr makes the
		// spiral wind in at the wrong rate and it can visibly stop short of the centre (a "donut")
		// or overshoot, instead of tracking the real geometry.
		const ppr = o.ppr ?? 1;
		const innerDiam = o.innerDiam ?? 0;
		playback.load(c, { ppr, innerDiam, stride: plot.liveFrmStride, axis: plot.frmAxis, cropStartSec: o.cropStartSec ?? undefined });
		replay.cacheId = o.cacheId; replay.label = o.label;
		replay.ppr = ppr; replay.innerDiam = innerDiam; replay.feed = c.feed;
		// 0 is a real, common outer_diameter value on this table meaning "use the .mat metadata",
		// not "override to zero" (db/migrations/20260721000096_force_outer_diameter.sql) — || so a
		// stored 0 falls through to the cache's own diameter, matching FrmPanel's existing
		// w.replay.diam || w.cfg.diam. ?? would have read Diameter and Surface speed as 0.
		replay.diam = o.outerDiam || c.diam;
		// The cache's own Fs is decimated for a force-app-recorded cut (finalize.py's
		// fs_eff = fs/stride) and can understate the true rate several times over — prefer the
		// row's own sample_rate (the true acquisition rate) when the cut has one.
		replay.sampleRate = o.sampleRate || c.Fs;
		replay.downloading = false;
		// A picked cut's descriptive metadata (RPM target, depth of cut, …) starts blank rather
		// than carrying over whatever the PREVIOUSLY picked cut's operation record happened to
		// hold — both are only ever set below, and only if this new cut's own record has a value.
		replay.rpm = 0;
		machining.axial_doc = ''; machining.radial_doc = ''; machining.cutting_length = '';
		machining.coolant_pressure = ''; machining.operation_sequence = ''; machining.chips_ref = '';
		machining.new_edge = false; machining.chips_collected = false;
		if (!o.operationId) return;
		try {
			const res = await api.get(`/items/manufacturing_operations/${o.operationId}`, {
				params: { fields: ['*',
					'sample_id.sample_id', 'sample_id.sample_code', 'sample_id.nickname',
					'operator_person_id.person_id', 'operator_person_id.full_name',
					'equipment_id.equipment_id', 'equipment_id.equipment_name',
					'tool_id.tool_id', 'tool_id.tool_code', 'tool_id.tool_name',
					'insert_edge_id.edge_id', 'insert_edge_id.edge_code',
					'insert_edge_id.insert_id.insert_id', 'insert_edge_id.insert_id.insert_code',
				] },
			});
			const d = res.data?.data;
			if (!d || my !== pickSeq) return;
			const rm = d.recorded_metadata || {};
			link.sampleId = d.sample_id?.sample_id || ''; link.sampleLabel = d.sample_id?.sample_code || d.sample_id?.nickname || '';
			link.operatorId = d.operator_person_id?.person_id || ''; link.operatorLabel = d.operator_person_id?.full_name || '';
			link.equipmentId = d.equipment_id?.equipment_id || ''; link.equipmentLabel = d.equipment_id?.equipment_name || '';
			link.toolId = d.tool_id?.tool_id || ''; link.toolLabel = d.tool_id?.tool_name || d.tool_id?.tool_code || '';
			link.insertId = d.insert_edge_id?.insert_id?.insert_id || ''; link.insertLabel = d.insert_edge_id?.insert_id?.insert_code || '';
			link.edgeId = d.insert_edge_id?.edge_id || ''; link.edgeLabel = d.insert_edge_id?.edge_code || '';
			meta.op_type = d.machining_operation_subtype || '';
			// Drives the RPM gauge's target in playback (see rpmTarget below) without touching cfg.
			if (d.machining_spindle_speed_rpm != null) replay.rpm = Number(d.machining_spindle_speed_rpm);
			meta.sample_name = rm.sample_name || link.sampleLabel || o.label;
			meta.coolant = rm.coolant || '';
			meta.notes = d.outcome_notes || rm.notes || '';
			machining.axial_doc = d.machining_axial_depth_of_cut_mm != null ? String(d.machining_axial_depth_of_cut_mm) : '';
			machining.radial_doc = d.machining_radial_depth_of_cut_mm != null ? String(d.machining_radial_depth_of_cut_mm) : '';
			machining.cutting_length = d.machining_cutting_length_mm != null ? String(d.machining_cutting_length_mm) : '';
			machining.coolant_pressure = d.machining_coolant_pressure_bar != null ? String(d.machining_coolant_pressure_bar) : '';
			machining.operation_sequence = d.operation_sequence != null ? String(d.operation_sequence) : '';
			machining.chips_ref = d.machining_chips_ref_code || '';
			machining.new_edge = !!d.machining_new_edge;
			machining.chips_collected = !!d.machining_chips_collected;
		} catch { /* best-effort — the cut is still replayable even if metadata hydration fails */ }
	}

	// The cut can end while the operator is on another page (the stream stays open, #185), so the
	// Save dialog and the finished cache are driven from here, not from RecordPage.
	watch(() => st.state, async (s, prev) => {
		if (mode.value === 'playback') return;   // playback never finalizes anything to save
		// Covers auto-stop (duration, disk full) where stop() was never called; a manual stop opens it in stop().
		if (shouldOpenSaveDialog(s, prev)) saveOpen.value = true;
		if (s === 'done' && prev !== 'done' && !finishedCache.value) await loadFinished();
	});

	return {
		client, source, setSource, nidaqChannels, cfg, meta, machining, plot, replay, st, busy, errMsg, finishedCache,
		editCutStartSec, editCutEndSec,
		isIdle, isRecording, isFinalizing, isDone, locked, sampleRateBlocker, startDisabled, stopDisabled, saveOpen,
		mode, playback, rpmTarget, acquireStream, releaseStream,
		start, stop, newRun, dismissFailure, clearSetup, loadFinished, searchCuts, pickReplayCut, metaObj, uploadCutToDatabase, saveCropLocally,
		// 2d: Directus links + run write-back
		link, logged, onSelectSample, logRunNow, syncStatus,
		searchSamples, searchOperators, searchEquipment, searchToolsForOp, searchEquipmentForOp, searchInserts, searchEdges,
		// 2e: safety alarms
		alarms,
		// converging between-cuts auto-range
		converge, convergeAfterCut,
		// R4: pre-flight checklist and the Start flow that honours it
		preflight, refreshPreflight, requestStart, startAnyway, sampleConfirmOpen,
		// R5: live rail warning banner (once per cut)
		railBanner, dismissRailBanner,
		// Recording-behaviour toggles (Detect cut start / Drift compensation / Converging auto-range)
		// and the cut-detect threshold — persisted, shared with Settings > Recording.
		recordingPrefs,
	};
}

export type Workspace = ReturnType<typeof createWorkspace>;
// #25: this file's own top comment says the workspace is "created once in RecordPage," but
// RecordPage.vue used to call createWorkspace() itself in its <script setup> -- which runs again
// on every mount, not once, since Vue unmounts route components by default. Navigating away from
// /record and back during a live cut silently built a brand-new RecordClient with empty buffers,
// discarding all previously-plotted data even though the recording itself (server-side) kept
// running untouched.
//
// A true module-level singleton fixes that, but it must be built LAZILY, not at import time:
// createWorkspace() touches localStorage on its very first line, and eagerly constructing it as
// `export const workspace = createWorkspace()` means merely IMPORTING this module -- e.g. a future
// unit test importing some unrelated export from this same file -- throws `ReferenceError:
// localStorage is not defined` in a plain Node/vitest environment with no DOM. getWorkspace() only
// builds the instance the first time something actually needs it (RecordPage.vue's own mount,
// same timing as before), then reuses it for the app's lifetime.
let _workspace: Workspace | null = null;
export function getWorkspace(): Workspace {
	// Detached scope: built inside RecordPage's setup, its watchers would otherwise belong to that
	// component and stop when it unmounts -- alarms, prefs and the deferred stream close included.
	if (!_workspace) _workspace = effectScope(true).run(createWorkspace)!;
	return _workspace;
}
export const WORKSPACE: InjectionKey<Workspace> = Symbol('record-workspace');
export function useWorkspace(): Workspace {
	const w = inject(WORKSPACE);
	if (!w) throw new Error('useWorkspace() outside a workspace provider');
	return w;
}
