// Recording-behaviour preferences that persist across launches and are shared between the Record
// page and Settings > Recording — a module-level singleton (same pattern as alarms.ts's
// alarmController), not per-workspace state. RecordPage and SettingsPage are separate route trees
// with no provide/inject relationship, so a value set in Settings needs to reach the next recording
// without a shared workspace instance to carry it.
//
// These three toggles were previously plain per-session fields on the workspace's `cfg`/`converge`
// objects, reset to their defaults every launch with no persistence and no explanation anywhere in
// the app of what they do or how to tune them — despite each one materially changing what gets
// recorded (when the live FRM starts winding, whether saved outputs are drift-corrected, whether
// the amp's ranges get retuned between cuts).
import { reactive, watch } from 'vue';

export interface RecordingPrefs {
	/** "Detect cut start": live FRM waits for the cut-start detector instead of winding from t=0. */
	frmFromCut: boolean;
	/** Linear drift compensation on saved outputs (.mat/live_cache) — the raw .d1raw is never touched. */
	driftComp: boolean;
	/** Apply auto-range recommendations to the amp between cuts (real hardware only; sim/replay preview it). */
	convergeEnabled: boolean;
	/** Absolute cut-detect force threshold (N) on |Fz|. 0 = adaptive (baseline mean + margin). */
	cutDetectForce: number;
}

const LS_KEY = 'force-app.recording.prefs';
const DEFAULTS: RecordingPrefs = {
	frmFromCut: false,
	driftComp: false,
	convergeEnabled: false,
	cutDetectForce: 0,
};

function load(): RecordingPrefs {
	try {
		return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
	} catch {
		return { ...DEFAULTS };
	}
}

export const recordingPrefs = reactive<RecordingPrefs>(load());

function persist(): void {
	localStorage.setItem(LS_KEY, JSON.stringify(recordingPrefs));
}

// Auto-persist on any change, from either surface that edits this object (the Record page's
// toggle switches, and Settings > Recording) — a manual save-button pattern here would mean
// forgetting it in one of the two places silently drops the other's edits on next launch.
watch(recordingPrefs, persist, { deep: true });
