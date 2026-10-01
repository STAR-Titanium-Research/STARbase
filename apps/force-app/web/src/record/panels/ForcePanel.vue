<script setup lang="ts">
// Force panel: rolling force bands (Time) or a live spectrum (FFT/Power/Spectrogram/Waterfall). The
// `inst` prop carries per-panel state — the selected channels (summed Fx/Fy/Fz and/or individual
// dyno sub-channels Fx1…Fz4) + the mode — so duplicated panels are independent (e.g. one showing
// only Fz1 to isolate a single sensor). The mode is picked in the panel's header (RecordPage.vue);
// without an `inst` this falls back to all summed axes in Time mode.
import { computed, ref, watch } from 'vue';
import { useWorkspace } from '../workspace';
import LiveForcePlot from '../LiveForcePlot.vue';
import FinishedForcePlot from '../FinishedForcePlot.vue';
import LiveFft from '../LiveFft.vue';
import LiveSpectrogram from '../LiveSpectrogram.vue';
import LiveWaterfall from '../LiveWaterfall.vue';
import { SUB_NAMES } from '../liveClient';
import { channelColor } from '../types';
import { theme } from '../../theme';
import { appUrl } from '../../appUrl';
import type { PlotMode } from '../plotModes';

const props = defineProps<{ inst?: { mode?: PlotMode; channels?: string[]; axes?: string[] } }>();
const w = useWorkspace();
const SUMMED = ['Fx', 'Fy', 'Fz'];
const ORDER = [...SUMMED, ...SUB_NAMES];

const mode = computed<PlotMode>(() => props.inst?.mode ?? 'time');
// Spectrogram/waterfall render a single channel; hint the user which one is shown.
const singleChannelMode = computed(() => mode.value === 'spectrogram' || mode.value === 'waterfall');
const localCh = ref<string[]>([...SUMMED]);
const selected = computed<string[]>(() => props.inst?.channels ?? props.inst?.axes ?? localCh.value);
function setSel(next: string[]) {
	const ordered = ORDER.filter((k) => next.includes(k));
	if (props.inst) props.inst.channels = ordered; else localCh.value = ordered;
}
// #32: spectrogram/waterfall only ever render selected[0] (a heatmap has nowhere to put a second
// channel), but this chip toggle used to let you tick as many as you liked regardless of mode --
// the extra chips lit up "on" with no visible effect, which reads as broken multi-select rather
// than the single-channel views they actually are. In singleChannelMode, picking a new channel
// REPLACES the selection instead of adding to it, so what's ticked always matches what's shown.
// Switching INTO spectrogram/waterfall from a mode that had several channels ticked (Time/FFT/
// Power all support that) must collapse to just the first, same reasoning as toggle() below --
// otherwise the chips still show a stale multi-selection that the view was never going to honor.
// immediate: true also collapses a stale multi-selection persisted from before this mode existed,
// or loaded from localStorage already in single-channel mode -- not just live mode switches.
watch(singleChannelMode, (single) => {
	if (single && selected.value.length > 1) setSel([selected.value[0]]);
}, { immediate: true });

function toggle(key: string) {
	if (singleChannelMode.value) { setSel([key]); return; }
	const s = selected.value.slice();
	const i = s.indexOf(key);
	if (i >= 0) { if (s.length > 1) s.splice(i, 1); } else s.push(key);
	setSel(s);
}
const subsOpen = ref(false);
const subCount = computed(() => selected.value.filter((k) => (SUB_NAMES as readonly string[]).includes(k)).length);
function openLive() {
	const q = new URLSearchParams({ mode: mode.value, channels: selected.value.join(','), window: String(w.plot.windowSec) });
	window.open(appUrl(`/live/force?${q}`), '_blank', 'noopener,width=1400,height=900');
}
</script>

<template>
	<div class="force-panel">
		<!-- Control order is deliberate and shared with the Plot dashboard's Signals panel:
			 channels (Fx/Fy/Fz) -> sub-channel dropdown -> time window. On both, the plot mode is
			 picked in the panel's header. -->
		<div class="controls">
			<div class="chips">
				<button v-for="a in SUMMED" :key="a" class="chip-toggle" :style="selected.includes(a) ? { '--c': channelColor(a, theme) } : {}"
					:class="{ on: selected.includes(a) }" @click="toggle(a)">{{ a }}</button>
			</div>
			<div class="subwrap">
				<button class="chip-toggle sub-btn" :class="{ on: subCount > 0 }" @click.stop="subsOpen = !subsOpen">
					Sub<span v-if="subCount"> · {{ subCount }}</span> <span class="material-symbols-rounded">expand_more</span>
				</button>
				<div v-if="subsOpen" class="subpop" @click.stop>
					<button v-for="s in SUB_NAMES" :key="s" class="subopt" :class="{ on: selected.includes(s) }" @click="toggle(s)">
						<span class="dot" :style="{ background: channelColor(s, theme) }"></span>{{ s }}
						<span v-if="selected.includes(s)" class="material-symbols-rounded tick">check</span>
					</button>
				</div>
			</div>
			<span v-if="singleChannelMode" class="mono-hint" title="Spectrogram/waterfall show one channel">{{ selected[0] }} only</span>
			<!-- Applies to every mode with an actual time dimension. FFT/PSD show a single current
				 spectrum with no time axis, so the control has nothing to affect there — hidden rather
				 than shown-but-inert. -->
			<div v-if="mode !== 'fft' && mode !== 'psd'" class="tw-row">
				<input type="range" min="2" max="60" step="1" v-model.number="w.plot.windowSec" />
				<input type="number" min="1" max="300" v-model.number="w.plot.windowSec" class="tw-num" />
				<span class="tw-unit">s</span>
			</div>
			<button class="btn icon sm popout" title="Pop out to a new window (second monitor) — open before Start"
				@click="openLive()">
				<span class="material-symbols-rounded">open_in_new</span>
			</button>
		</div>
		<div class="plot" @click="subsOpen = false">
			<!-- Skipped while the save dialog is open: it renders the same full-resolution trace over
				 this panel anyway, and the moment recording ends is already the heaviest instant on the
				 page (FRM rebuild + this panel + the dialog's own copy all wanting to redraw at once) —
				 no point paying for a redundant draw of data the user can't currently see. -->
			<FinishedForcePlot v-if="mode === 'time' && w.isDone.value && w.finishedCache.value && !w.saveOpen.value" :cache="w.finishedCache.value" :channels="selected" />
			<LiveForcePlot v-else-if="mode === 'time'" :client="w.client" :channels="selected" />
			<LiveFft v-if="mode === 'fft' || mode === 'psd'" :client="w.client" :channels="selected" :scale="mode === 'psd' ? 'psd' : 'amp'" />
			<LiveSpectrogram v-else-if="mode === 'spectrogram'" :client="w.client" :channels="selected" :window-sec="w.plot.windowSec" />
			<LiveWaterfall v-else-if="mode === 'waterfall'" :client="w.client" :channels="selected" :window-sec="w.plot.windowSec" />
		</div>
	</div>
</template>

<style scoped>
.force-panel { display: flex; flex-direction: column; height: 100%; gap: 8px; }
.controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.chips { display: flex; gap: 5px; }
.subwrap { position: relative; }
.sub-btn.on { --c: var(--accent); }
.subpop { position: absolute; top: 30px; left: 0; z-index: 40; min-width: 118px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 9px; padding: 4px; box-shadow: 0 12px 34px rgba(0,0,0,0.3); }
.subopt { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 7px; font-size: var(--fs-sm); color: var(--text); background: transparent; border: none; border-radius: 6px; cursor: pointer; text-align: left; }
.subopt:hover { background: var(--surface-2); }
.subopt.on { color: var(--text); font-weight: 600; }
.subopt .dot { width: 9px; height: 9px; border-radius: 50%; }
.subopt .tick { margin-left: auto; font-size: var(--icon-xs); color: var(--ok); }
.mono-hint { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-dim); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 3px 7px; }
.tw-row { display: flex; align-items: center; gap: 4px; }
.tw-row input[type="range"] { width: 80px; accent-color: var(--accent); }
.tw-num { width: 42px !important; text-align: center; padding: 3px 2px !important; font-size: var(--fs-xs) !important; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; color: var(--text); }
.tw-unit { font-size: var(--fs-xs); color: var(--text-dim); }
.popout { margin-left: auto; }
.plot { flex: 1; min-height: 0; position: relative; }
.plot > * { position: absolute; inset: 0; }
</style>
