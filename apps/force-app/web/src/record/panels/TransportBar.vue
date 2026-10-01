<script setup lang="ts">
// Video-style transport for replaying an archived cut: play/pause, a scrub bar, an elapsed /
// total readout and a speed picker. Playback writes nothing — this drives a playhead over a cut
// already in the database, so there is no Stop and no Save.
import { computed } from 'vue';
import { useWorkspace } from '../workspace';
import { formatDuration as fmt } from '../../format';

const w = useWorkspace();
const p = computed(() => w.playback.state);

// Scrubbing fires continuously while dragging; only the settled value forces a spectrum request
// (the FFT / spectrogram views are the expensive part). `input` = dragging, `change` = released.
function onScrub(e: Event) { w.playback.seek(Number((e.target as HTMLInputElement).value), { commit: false }); }
function onScrubEnd(e: Event) { w.playback.seek(Number((e.target as HTMLInputElement).value), { commit: true }); }

const SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 20];
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
			<input class="scrub" type="range" min="0" :max="p.duration || 0" step="0.01"
				:value="p.tSec" :disabled="!p.loaded || w.replay.downloading" @input="onScrub" @change="onScrubEnd" />
			<span class="time">{{ fmt(p.tSec) }} / {{ fmt(p.duration) }}</span>
		</div>
		<div class="row sub">
			<label class="speed">Speed
				<select :value="p.speed" @change="w.playback.setSpeed(Number(($event.target as HTMLSelectElement).value))">
					<option v-for="s in SPEEDS" :key="s" :value="s">{{ s }}×</option>
				</select>
			</label>
			<span class="note" title="This file stores summed Fx/Fy/Fz only. Per-sensor sub-channels are shown as an even split, and Tacho is not stored at all — RPM comes from the file's own rpm series.">
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
.scrub { flex: 1 1 90px; min-width: 90px; accent-color: var(--accent); cursor: pointer; }
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
