// Safety alarms (slice 2e) — software force/RPM thresholds evaluated on the live stream, mirroring
// the MATLAB app's alarms. Latching: once a threshold is breached the alarm fires and stays until
// acknowledged (safety-first). A looping attention tone plays via the Web Audio API while tripped.
import { reactive, ref } from 'vue';
import { getConfig } from '../config';

export interface AlarmConfig {
	forceEnabled: boolean;
	forceThreshold: number;   // N (per-axis peak magnitude)
	rpmEnabled: boolean;
	rpmThreshold: number;     // 0 => auto = configured spindle RPM × 1.02
	audioEnabled: boolean;
	diskEnabled: boolean;
	diskThresholdGb: number;  // warn when free space drops below this (GB)
}
export interface ActiveAlarm { key: string; kind: 'force' | 'rpm' | 'disk' | 'tacho'; label: string; value: number; threshold: number; at: number; }

const LS_KEY = 'force-app.alarms.config';
const DEFAULTS: AlarmConfig = { forceEnabled: true, forceThreshold: 400, rpmEnabled: true, rpmThreshold: 0, audioEnabled: true, diskEnabled: true, diskThresholdGb: 5 };

function loadCfg(): AlarmConfig {
	try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export class AlarmController {
	config = reactive<AlarmConfig>(loadCfg());
	active = reactive<ActiveAlarm[]>([]);      // latched breaches (kept until reset)
	// Per-key acknowledgment, not a single global flag. RecordPage.vue's confirmation dialog is
	// async (unlike the window.confirm() it replaced, which blocked the whole renderer) — an alarm
	// can fire in the gap between the dialog opening and the operator clicking Silence. A single
	// `acknowledged` boolean would silence THAT alarm too, even though it was never shown or
	// consented to; tracking which specific keys were acknowledged means a key that arrives mid-dialog
	// stays tripped regardless of what the operator just confirmed.
	private ackedKeys = reactive(new Set<string>());
	private latched = new Set<string>();
	// Whether alarms have been fired (via test() or a real breach) at least once since this app
	// process started — gates the "alarms untested" prompt shown before the first recording.
	// Deliberately module-lifetime, not per-recording: reset() (called at the start of every
	// recording) must NOT clear it, or the prompt would nag on every single start.
	testedSinceStart = ref(false);

	// Web Audio attention tone
	private ctx: AudioContext | null = null;
	private osc: OscillatorNode | null = null;
	private gain: GainNode | null = null;
	private beat: number | null = null;

	saveCfg() { localStorage.setItem(LS_KEY, JSON.stringify(this.config)); }

	get tripped(): boolean { return this.active.some((a) => !this.ackedKeys.has(a.key)); }

	rpmLimit(spindleRpm: number): number {
		return this.config.rpmThreshold > 0 ? this.config.rpmThreshold : spindleRpm * 1.02;
	}

	// Evaluate one live update. `peaks` are running max per axis; `rpm` is current.
	evaluate(peaks: { Fx: number; Fy: number; Fz: number }, rpm: number, spindleRpm: number): void {
		let fired = false;
		if (this.config.forceEnabled) {
			for (const ax of ['Fx', 'Fy', 'Fz'] as const) {
				const v = Math.abs(peaks[ax] ?? 0);
				const key = `force:${ax}`;
				if (v >= this.config.forceThreshold && !this.latched.has(key)) {
					this.latched.add(key);
					this.active.push({ key, kind: 'force', label: `${ax} force`, value: v, threshold: this.config.forceThreshold, at: Date.now() });
					fired = true;
				}
			}
		}
		if (this.config.rpmEnabled) {
			const lim = this.rpmLimit(spindleRpm);
			const key = 'rpm';
			if (rpm >= lim && !this.latched.has(key)) {
				this.latched.add(key);
				this.active.push({ key, kind: 'rpm', label: 'Spindle RPM', value: rpm, threshold: lim, at: Date.now() });
				fired = true;
			}
		}
		// No need to un-acknowledge anything explicitly: a freshly-pushed key is by construction
		// absent from ackedKeys, so `tripped` already reads true for it.
		if (fired && this.config.audioEnabled) this.startTone();
	}

	/** A tacho that reports no readable pulses while recording is a fault, not a quiet spindle.
	 *
	 * Gated on rpmEnabled because this IS the high-RPM alarm's integrity check: that alarm compares
	 * measured RPM against a limit, so a silent tacho leaves it permanently unable to trip. Before
	 * the backend fix, an unreadable tacho reported the configured spindle speed instead of nothing,
	 * so the alarm sat at a plausible-looking value and could never fire — the failure was invisible
	 * from the UI. Latched like every other alarm so it survives a momentary recovery. */
	evaluateTacho(ok: boolean | null): void {
		if (!this.config.rpmEnabled || ok !== false) return;
		const key = 'tacho';
		if (this.latched.has(key)) return;
		this.latched.add(key);
		this.active.push({ key, kind: 'tacho', label: 'No tacho signal — RPM alarm cannot protect', value: 0, threshold: 0, at: Date.now() });
		if (this.config.audioEnabled) this.startTone();
	}

	evaluateDisk(freeGb: number): void {
		if (!this.config.diskEnabled) return;
		const key = 'disk';
		if (freeGb < this.config.diskThresholdGb && !this.latched.has(key)) {
			this.latched.add(key);
			this.active.push({ key, kind: 'disk', label: 'Low disk space', value: freeGb, threshold: this.config.diskThresholdGb, at: Date.now() });
			if (this.config.audioEnabled) this.startTone();
		}
	}

	/** Acknowledge specific alarms by key — normally exactly the ones the confirmation dialog just
	 * showed, so an alarm that fired while the dialog was open (and so was never shown or
	 * consented to) is left tripped rather than swept into "acknowledged" alongside it. Omit `keys`
	 * to acknowledge everything currently active. The tone only stops once nothing is left
	 * unacknowledged — if `keys` didn't cover everything, the alert correctly keeps going. */
	acknowledge(keys?: string[]): void {
		for (const k of keys ?? this.active.map((a) => a.key)) this.ackedKeys.add(k);
		if (!this.tripped) this.stopTone();
	}
	reset(): void { this.active.splice(0); this.latched.clear(); this.ackedKeys.clear(); this.stopTone(); }

	// Fire a synthetic alarm so operators can confirm the alert works. Auto-clears after 5s —
	// unlike a real breach, a test alarm has nothing to acknowledge, so previously it just rang
	// forever until the operator found their way to the Record page's Acknowledge button (which
	// isn't even visible from Settings, where "Test alarm" lives).
	test(): void {
		const key = `test:${Date.now()}`;
		this.latched.add(key);
		this.active.push({ key, kind: 'force', label: 'TEST alarm', value: 999, threshold: 0, at: Date.now() });
		this.testedSinceStart.value = true;
		if (this.config.audioEnabled) this.startTone();
		setTimeout(() => {
			if (this.latched.has(key)) {
				this.latched.delete(key);
				this.ackedKeys.delete(key); // avoid unbounded growth if it happened to get acked first
				this.active.splice(this.active.findIndex((a) => a.key === key), 1);
			}
			if (!this.tripped) this.stopTone();
		}, 5000);
	}

	// ---- audio (looping beep) ----
	private ensureCtx() {
		if (!this.ctx) {
			this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
			this.gain = this.ctx.createGain(); this.gain.gain.value = 0; this.gain.connect(this.ctx.destination);
			this.osc = this.ctx.createOscillator(); this.osc.type = 'square'; this.osc.frequency.value = 880;
			this.osc.connect(this.gain); this.osc.start();
		}
		if (this.ctx.state === 'suspended') void this.ctx.resume();
	}
	private startTone() {
		this.ensureCtx();
		if (this.beat != null) return;
		// Force system volume to maximum for catastrophic alarms (best-effort, requires backend)
		this.forceMaxVolume();
		let on = false;
		this.beat = window.setInterval(() => {
			on = !on;
			if (this.gain) this.gain.gain.value = on ? 0.35 : 0.0;
		}, 350);
	}
	private forceMaxVolume() {
		fetch(`${getConfig().recorderUrl}/audio/maxvolume`, { method: 'POST' }).catch(() => {});
	}
	private stopTone() {
		if (this.beat != null) { clearInterval(this.beat); this.beat = null; }
		if (this.gain) this.gain.gain.value = 0;
	}
}

// App-wide singleton: the Record page evaluates it on the live stream + shows the overlay, while
// Settings > Alarms edits the same config.
export const alarmController = new AlarmController();
