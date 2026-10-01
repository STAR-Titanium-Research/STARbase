<script setup lang="ts">
// Recording-behaviour settings: the three toggles on the Record page's "Recording behaviour"
// section each materially change what gets recorded, but previously had nowhere to be explained
// or (for cut-start detection) tuned — Detect cut start's threshold existed in the backend
// RecordConfig and was never reachable from the UI at all. This is that home; the toggles
// themselves stay on the Record page (they're a per-cut decision), this is where you understand
// and configure them.
import { recordingPrefs } from '../record/recordingPrefs';
import ToggleSwitch from '../ui/ToggleSwitch.vue';

// '' displays as the placeholder (adaptive); typing clears back to 0 = adaptive if left empty.
function onThresholdInput(e: Event) {
	const raw = (e.target as HTMLInputElement).value.trim();
	recordingPrefs.cutDetectForce = raw === '' ? 0 : Math.max(0, Number(raw) || 0);
}
</script>

<template>
	<div class="recset">
		<h2>Recording behaviour</h2>
		<p class="lead">
			Three settings on the Record page change what actually gets captured or how it's processed.
			The switches live there, next to the cut you're about to run — this is where to understand
			and configure them.
		</p>

		<div class="card">
			<div class="card-head">
				<h3>Detect cut start</h3>
				<ToggleSwitch v-model="recordingPrefs.frmFromCut" label="Detect cut start" />
			</div>
			<p class="desc">
				When on, the live force-response-map (FRM) spiral holds at the origin until the cut is
				detected, then starts winding from there — so air-cut revolutions before the tool touches
				down don't offset the fingerprint. When off, it winds from the moment recording starts.
			</p>
			<label class="field">
				<span>Detection threshold</span>
				<input
					type="number" min="0" step="1" placeholder="Adaptive (baseline + margin)"
					:value="recordingPrefs.cutDetectForce || ''"
					@input="onThresholdInput"
				/>
				<span class="unit">N</span>
			</label>
			<p class="hint">
				Absolute force on |Fz| that counts as "the cut has started." Leave blank for adaptive
				detection (the baseline noise floor plus a margin) — set an explicit value only if a
				particular setup's baseline is unusually noisy and adaptive detection fires too early or
				too late.
			</p>
		</div>

		<div class="card">
			<div class="card-head">
				<h3>Drift compensation</h3>
				<ToggleSwitch v-model="recordingPrefs.driftComp" label="Drift compensation" />
			</div>
			<p class="desc">
				Applies a linear drift correction (matching the MATLAB app) to the saved outputs — the
				<code>.mat</code> file and the live cache used for plotting. It removes a slow linear trend
				across the whole recording, which typically comes from charge-amplifier drift rather than
				real cutting force.
			</p>
			<p class="hint">
				<b>The raw capture (<code>.d1raw</code>) is never touched</b> — it always holds exactly what
				the amp reported. Turning this on or off later and re-deriving the outputs from the raw
				file reproduces the same result either way; nothing is lost by getting this wrong now.
			</p>
		</div>

		<div class="card">
			<div class="card-head">
				<h3>Converging auto-range</h3>
				<ToggleSwitch v-model="recordingPrefs.convergeEnabled" label="Converging auto-range" />
			</div>
			<p class="desc">
				After each cut, recommends new per-channel measuring ranges on the Lab Amp from that
				cut's actual peaks, and applies them for the next one — so a channel that was badly
				over- or under-ranged converges toward using the amp's full resolution over a pass or two.
			</p>
			<p class="hint">
				Only takes effect with the NI-DAQ source; on Simulated or Replay it previews the
				recommendation without applying it. The tunable part — how much headroom above the peak
				to leave — lives on the Lab Amp page, since it's a property of the amp's ranging, not of
				a specific recording.
			</p>
			<router-link class="cfg-link" to="/labamp">
				<span class="material-symbols-rounded">memory</span>
				Configure headroom on the Lab Amp page
				<span class="material-symbols-rounded arrow">arrow_forward</span>
			</router-link>
		</div>
	</div>
</template>

<style scoped>
.recset { max-width: 640px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.lead { margin: 0 0 18px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.card { margin-bottom: 16px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.card-head h3 { margin: 0; font-size: var(--fs-lg); color: var(--text); }
.desc { margin: 0 0 10px; font-size: var(--fs-md); line-height: 1.55; color: var(--text); }
.desc code, .hint code { font-family: var(--mono); font-size: var(--fs-sm); background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
.hint { margin: 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--text-dim); }
.field { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; font-size: var(--fs-md); color: var(--text); }
.field span:first-child { flex-shrink: 0; }
.field input { width: 160px; padding: 7px 9px; font-size: var(--fs-md); color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 7px; outline: none; }
.field input:focus { border-color: var(--accent); }
.field .unit { color: var(--text-dim); }
.cfg-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 7px 12px; font-size: var(--fs-md); font-weight: 600; color: var(--accent); background: var(--surface-2); border-radius: 8px; text-decoration: none; }
.cfg-link:hover { background: var(--surface); }
.cfg-link .material-symbols-rounded { font-size: var(--icon-sm); }
.cfg-link .arrow { font-size: var(--icon-xs); }
</style>
