<script setup lang="ts">
// Safety-alarm thresholds (the app-wide controller the Record page evaluates on the live stream).
import { alarmController, type AlarmConfig } from '../record/alarms';
import { confirmAction } from '../ui/confirm';
const a = alarmController;
function save() { a.saveCfg(); }

function onWarnPercent() {
	const p = Math.round(Number(a.config.warnPercent));
	a.config.warnPercent = Number.isFinite(p) ? Math.min(99, Math.max(1, p)) : 80;
	save();
}
function setCustomVolume(ev: Event) {
	a.config.toneVolume = (ev.target as HTMLInputElement).checked ? 50 : null;
	save();
}

type ToggleKey = 'forceEnabled' | 'rpmEnabled' | 'diskEnabled' | 'audioEnabled';

// What the operator gives up by switching each one off. Spelled out per alarm rather than a generic
// "are you sure?" — the point of the prompt is that they read the specific consequence.
const DISABLE_WARNING: Record<ToggleKey, { title: string; message: string }> = {
	forceEnabled: {
		title: 'Disable the high-force alarm?',
		message: 'Nothing will warn you if cutting force exceeds the threshold. Overload can damage the dynamometer, the tool, or the workpiece.',
	},
	rpmEnabled: {
		title: 'Disable the high-RPM alarm?',
		message: 'Nothing will warn you if the spindle overspeeds, and the app will stop checking that the tacho is actually reporting.',
	},
	diskEnabled: {
		title: 'Disable the low-disk alarm?',
		message: 'A recording can fill the captures drive and be cut short. You will get no warning before it happens.',
	},
	audioEnabled: {
		title: 'Turn off the audible alert?',
		message: 'Alarms will still latch and show on screen, but make no sound — easy to miss if you are at the machine rather than the screen.',
	},
};

/** Confirm before turning a safety alarm OFF; turning one back ON is never gated.
 *
 * Takes the event so the checkbox can be forced back to the model's value when the operator
 * declines. The browser has already flipped the box by the time @change fires, and leaving the
 * reactive value untouched does NOT undo that: Vue diffs vnodes, sees no change in `:checked`, and
 * patches nothing — so the box would sit unchecked while the alarm is still armed. */
async function setEnabled(key: ToggleKey, ev: Event) {
	const el = ev.target as HTMLInputElement;
	const next = el.checked;
	if (!next) {
		const { title, message } = DISABLE_WARNING[key];
		const ok = await confirmAction({
			title,
			message,
			detail: 'You can turn it back on here at any time.',
			confirmLabel: 'Disable',
			cancelLabel: 'Keep it on',
			tone: 'danger',
		});
		if (!ok) {
			el.checked = a.config[key]; // undo the browser's optimistic toggle
			return;
		}
	}
	(a.config as AlarmConfig)[key] = next;
	save();
}
</script>

<template>
	<div class="alarms">
		<h2>Safety alarms</h2>
		<p class="lead">Evaluated on the live force stream while recording. When a threshold is breached the
			alarm latches (with a full-screen banner + optional tone on the Record page) until acknowledged.</p>

		<div class="grp">
			<label class="chk"><input type="checkbox" :checked="a.config.forceEnabled" @change="setEnabled('forceEnabled', $event)" /> High-force alarm</label>
			<label class="thr">Trip at ≥ <input type="number" v-model.number="a.config.forceThreshold" :disabled="!a.config.forceEnabled" @change="save" /> N (per-axis peak)</label>
			<p class="hint">Default ~400 N peak; set to a safe fraction of your dynamometer / setup limit.</p>
			<label class="chk sub"><input type="checkbox" v-model="a.config.warnEnabled" :disabled="!a.config.forceEnabled" @change="save" /> Early warning</label>
			<label class="thr">Warn at ≥ <input type="number" min="1" max="99" v-model.number="a.config.warnPercent" :disabled="!a.config.forceEnabled || !a.config.warnEnabled" @change="onWarnPercent" /> % of the limit<span v-if="a.warnLevel != null" class="calc">({{ a.warnLevel.toFixed(0) }} N)</span></label>
			<p class="hint">An amber banner on the Record page, with no tone, before the alarm itself trips. It does not latch.</p>
			<label class="chk sub"><input type="checkbox" v-model="a.config.stopOnForceAlarm" :disabled="!a.config.forceEnabled" @change="save" /> Stop the recording when the force alarm trips (Record page open)</label>
			<p class="hint">Off by default. The recording is stopped the same way as the Stop button, and the save dialog opens. The alarm is only checked while the Record page is open, so leaving that page during a cut turns this off for that cut, and so does closing the window. The alarm banner and tone keep going until you acknowledge them (press A, or click Acknowledge).</p>
		</div>

		<div class="grp">
			<label class="chk"><input type="checkbox" :checked="a.config.rpmEnabled" @change="setEnabled('rpmEnabled', $event)" /> High-RPM alarm</label>
			<label class="thr">Trip at ≥ <input type="number" v-model.number="a.config.rpmThreshold" :disabled="!a.config.rpmEnabled" placeholder="0 = auto" @change="save" /> RPM</label>
			<p class="hint">0 = auto: the configured spindle speed × 1.02. Set an explicit value to cap regardless of the programmed RPM.</p>
		</div>

		<div class="grp">
			<label class="chk"><input type="checkbox" :checked="a.config.diskEnabled" @change="setEnabled('diskEnabled', $event)" /> Low disk space alarm</label>
			<label class="thr">Alert when free space &lt; <input type="number" v-model.number="a.config.diskThresholdGb" :disabled="!a.config.diskEnabled" @change="save" /> GB</label>
			<p class="hint">Fires during recording if the captures drive runs low. Recording will stop gracefully to prevent data loss.</p>
		</div>

		<div class="grp">
			<label class="chk"><input type="checkbox" :checked="a.config.audioEnabled" @change="setEnabled('audioEnabled', $event)" /> Audible alert (looping tone)</label>
			<label class="chk sub"><input type="checkbox" :checked="a.config.toneVolume != null" :disabled="!a.config.audioEnabled" @change="setCustomVolume" /> Set the tone volume</label>
			<label v-if="a.config.toneVolume != null" class="thr">Volume
				<input type="range" min="5" max="100" step="5" v-model.number="a.config.toneVolume" :disabled="!a.config.audioEnabled" @change="save" class="vol" />
				{{ a.config.toneVolume }} %</label>
			<p class="hint">Unticked: the app raises the system volume to maximum when an alarm sounds. Ticked: the system volume is left alone, so set it yourself.</p>
		</div>

		<button class="btn" @click="a.test()">Test alarm</button>
	</div>
</template>

<style scoped>
.alarms { max-width: 620px; }
h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.lead { margin: 0 0 18px; font-size: var(--fs-md); color: var(--text-dim); line-height: 1.5; }
.grp { margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.chk { display: flex; align-items: center; gap: 8px; font-size: var(--fs-md); color: var(--text); cursor: pointer; margin-bottom: 8px; }
.chk input { accent-color: var(--accent); }
.thr { display: flex; align-items: center; gap: 6px; font-size: var(--fs-md); color: var(--text-dim); }
.thr input { width: 90px; padding: 6px 9px; font-size: var(--fs-md); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; text-align: right; }
.chk.sub { margin-top: 12px; }
.thr .calc { color: var(--text-dim); }
.thr input.vol { width: 160px; padding: 0; accent-color: var(--accent); }
.thr input:disabled { opacity: 0.5; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); margin: 6px 0 0; line-height: 1.5; }
</style>
