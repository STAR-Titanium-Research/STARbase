<script setup lang="ts">
// Video-style transport for replaying an archived cut: play/pause, a scrub bar, an elapsed /
// total readout and a speed picker. Playback writes nothing — this drives a playhead over a cut
// already in the database, so there is no Stop and no Save.
import { computed, onBeforeUnmount } from 'vue';
import { useWorkspace } from '../workspace';
import { formatDuration as fmt } from '../../format';
import { channelColor } from '../types';
import { theme } from '../../theme';
import { markerFraction, type TimelineMarker } from '../playback/markers';

const w = useWorkspace();
const p = computed(() => w.playback.state);
// The scrub runs over the cache's own time base, [t0, t0 + duration] (#110): a MATLAB cache holds
// only the cut window, so its first sample sits seconds into the original signal. The readout
// shows time ELAPSED into the cut against its length; the tooltip keeps the signal time, which
// is what the force plot's x-axis is labelled in.
const tEnd = computed(() => p.value.t0 + p.value.duration);
const elapsed = computed(() => Math.max(0, p.value.tSec - p.value.t0));
const timeTitle = computed(() => (p.value.t0 > 0
	? `Signal time ${p.value.tSec.toFixed(2)} s — this file starts ${p.value.t0.toFixed(2)} s into the recording`
	: `Signal time ${p.value.tSec.toFixed(2)} s`));

// Scrubbing fires continuously while dragging; only the settled value forces a spectrum request
// (the FFT / spectrogram views are the expensive part). `input` = dragging, `change` = released.
// A drag can fire `input` several times per frame, and each seek is a buffer rebuild plus a relay
// to any pop-out, so they are coalesced to the latest value once per animation frame (#107).
let pendingSeek: number | null = null;
let seekFrame = 0;
function onScrub(e: Event) {
	pendingSeek = Number((e.target as HTMLInputElement).value);
	if (seekFrame) return;
	seekFrame = requestAnimationFrame(() => {
		seekFrame = 0;
		if (pendingSeek !== null) w.playback.seek(pendingSeek, { commit: false });
		pendingSeek = null;
	});
}
function onScrubEnd(e: Event) {
	if (seekFrame) { cancelAnimationFrame(seekFrame); seekFrame = 0; }
	pendingSeek = null;
	w.playback.seek(Number((e.target as HTMLInputElement).value), { commit: true });
}
onBeforeUnmount(() => { if (seekFrame) cancelAnimationFrame(seekFrame); });

const SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 20];

// #104: cut start/end, a saved crop, and each axis's |F| peak, on a lane under the scrub bar (not
// on it, so they never get in the way of grabbing the thumb). Click one to jump there.
function markerStyle(m: TimelineMarker) {
	const f = markerFraction(m.t, p.value.t0, p.value.duration);
	// The range input's track is inset by half its thumb (~8px) at each end; match it so a marker
	// sits under the thumb when the playhead is on it.
	const color = m.kind === 'peak' && m.axis ? channelColor(m.axis, theme.value) : undefined;
	return { left: `calc(8px + (100% - 16px) * ${f})`, ...(color ? { '--mc': color } : {}) };
}
// Computed, not called per marker in the template: the bar re-renders at ~60 Hz while playing, but
// the styles only change with the cut (markers, t0, duration) or the theme, never with tSec.
const markerItems = computed(() => p.value.markers.map((m) => ({
	m, key: `${m.kind}-${m.axis ?? ''}-${m.t}`, style: markerStyle(m),
})));
function seekTo(m: TimelineMarker) { w.playback.seek(m.seekT ?? m.t, { commit: true }); }
</script>

<template>
	<div class="transport">
		<!-- The Recording panel is user-resizable and can get narrow. Keeping this on one row meant
			 the scrub bar (flex:1, min-width:0) was squeezed to nothing by the play button and the
			 time readout — measured at 0 px below ~1030 px of window width, i.e. genuinely
			 unusable, not merely cramped. The scrub now holds a floor width and the readout drops
			 to its own line instead. -->
		<div class="row transport-main">
			<button class="btn icon success play" :disabled="!p.loaded || w.replay.downloading" :title="p.playing ? 'Pause' : 'Play'" @click="w.playback.toggle()">
				<span class="material-symbols-rounded" :class="{ spin: w.replay.downloading }">
					{{ w.replay.downloading ? 'progress_activity' : p.playing ? 'pause' : 'play_arrow' }}
				</span>
			</button>
			<div class="scrub-wrap">
				<input class="scrub" type="range" :min="p.t0" :max="tEnd" step="0.01"
					:value="p.tSec" :disabled="!p.loaded || w.replay.downloading" @input="onScrub" @change="onScrubEnd" />
				<div v-if="p.loaded && p.markers.length" class="marks">
					<button v-for="it in markerItems" :key="it.key" type="button"
						class="mark" :class="it.m.kind" :style="it.style" :title="it.m.label" :aria-label="`Jump to ${it.m.label}`"
						@click="seekTo(it.m)"></button>
				</div>
			</div>
			<span class="time" :title="timeTitle">{{ fmt(elapsed) }} / {{ fmt(p.duration) }}</span>
		</div>
		<div class="row sub">
			<label class="speed">Speed
				<select :value="p.speed" @change="w.playback.setSpeed(Number(($event.target as HTMLSelectElement).value))">
					<option v-for="s in SPEEDS" :key="s" :value="s">{{ s }}×</option>
				</select>
			</label>
			<span class="note" title="This file stores summed Fx/Fy/Fz only. Per-sensor sub-channels are shown as an even split, and the raw tacho pulse train is not stored — the Tacho channel shows the file's own RPM series (empty when the file has none).">
				<span class="material-symbols-rounded">info</span> summed axes only
			</span>
		</div>
		<p v-if="w.replay.downloading" class="hint loading">
			<span class="material-symbols-rounded spin">progress_activity</span> Loading cut…
		</p>
		<p v-else-if="p.error" class="err">{{ p.error }}</p>
		<p v-else-if="!p.loaded" class="hint">Pick a cut above to load it.</p>
	</div>
</template>

<style scoped>
.transport { display: flex; flex-direction: column; gap: 7px; padding: 9px 0 2px; border-top: 1px solid var(--border); }
.row { display: flex; align-items: center; gap: 9px; }
.row.sub { justify-content: space-between; }
/* Wrap rather than crush: below the width where all three fit, the time readout moves to its own
   line and the scrub keeps its floor. */
.transport-main { flex-wrap: wrap; }
/* The shared Start-green icon button, round like a media control. */
.play { flex-shrink: 0; border-radius: 50%; }
.play .material-symbols-rounded { font-size: var(--icon-lg); }
/* min-width, NOT the usual `min-width: 0`: this control has to stay grabbable. Under the floor
   the row wraps (above) instead of shrinking it away to a zero-width, unclickable element. */
.scrub-wrap { flex: 1 1 90px; min-width: 90px; display: flex; flex-direction: column; }
.scrub { width: 100%; margin: 0; accent-color: var(--accent); cursor: pointer; }
/* Marker lane under the track. Peaks take their axis colour (--mc); the cut window and crop are
   neutral ticks, so they read as boundaries rather than as a fourth channel. */
.marks { position: relative; height: 10px; }
.mark { position: absolute; top: 1px; width: 8px; height: 8px; margin-left: -4px; padding: 0; border: none; border-radius: 50%; background: var(--mc, var(--text-dim)); cursor: pointer; opacity: 0.9; }
.mark:hover, .mark:focus-visible { opacity: 1; transform: scale(1.35); }
.mark.cut-start, .mark.cut-end, .mark.crop { width: 3px; height: 10px; top: 0; margin-left: -1.5px; border-radius: 1px; }
.mark.cut-start, .mark.cut-end { background: var(--text-dim); }
.mark.crop { background: var(--accent); }
.scrub:disabled { opacity: 0.5; cursor: not-allowed; }
.time { font-size: var(--fs-sm); font-family: var(--mono); color: var(--text-dim); font-variant-numeric: tabular-nums; flex-shrink: 0; margin-left: auto; }
.speed { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-dim); margin: 0; }
.speed select { width: auto; margin: 0; padding: 4px 7px; font-size: var(--fs-sm); }
.note { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--text-dim); cursor: help; }
.note .material-symbols-rounded { font-size: var(--icon-xs); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 2px 0 0; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); margin: 2px 0 0; }
.hint.loading { display: flex; align-items: center; gap: 5px; }
</style>
