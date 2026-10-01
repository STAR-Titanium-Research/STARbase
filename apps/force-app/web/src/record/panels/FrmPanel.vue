<script setup lang="ts">
// FRM panel: the live accumulating spiral while recording; the captured fingerprint (rendered via
// the plotting FrmCloud from the backend's D1LC) once done.
import { computed, ref, watch } from 'vue';
import { useWorkspace } from '../workspace';
import LiveFrm from '../LiveFrm.vue';
import { FrmCloud, ColorScaleEditor, defaultScale, useAutoColorScale, withOpenDisplay, type ColorScale, type Histogram } from '@d1/force-plotting';
import { appUrl } from '../../appUrl';
const w = useWorkspace();
const STRIDES = [1, 2, 5, 10, 25, 50];
const editorOpen = ref(false);

// FrmCloud.vue and LiveFrm.vue both take a ColorScale prop now (Stage 2/3/4 of the colour-scale
// port); Stage 5 adds the full editor here. `colorScale` is this panel's real source of truth
// (satMin/satMax/dispMin/dispMax/steps/params), driven by ColorScaleEditor.vue's
// update:colorScale. Sharing one ref/handler between FrmCloud and LiveFrm is safe ONLY because the
// v-if/v-else below makes them mutually exclusive (never both mounted) -- it is NOT continuous
// across the live-to-captured swap: autoClimits still holds LiveFrm's last symmetric running-max
// range for one to two frames after w.isDone flips FrmCloud in, until FrmCloud's own
// emitAutoRange() fires and snaps to its percentile range, so the very first captured-view frame
// briefly washes colour toward the middle of the ramp. Not worth fixing -- resetting autoClimits
// on the swap would flash [0,1] instead, which is worse -- but real, and invisible only because it
// self-corrects within a frame or two.
const { colorScale, locked, autoClimits, onClimits } =
	useAutoColorScale({ initial: { ...defaultScale(0, 1), colormap: w.plot.colormap } });
// The displayed range is in absolute units of the channel it was set on; reopen it on a switch.
watch(() => w.plot.frmAxis, () => { colorScale.value = withOpenDisplay(colorScale.value); });
// Two-way with the shared workspace colormap (Polar panel's select, pop-out seed).
watch(() => w.plot.colormap, (c) => {
	if (c && c !== colorScale.value.colormap) colorScale.value = { ...colorScale.value, colormap: c };
});
function onColorScaleUpdate(v: ColorScale) {
	colorScale.value = v;
	w.plot.colormap = v.colormap;
}
const colorDomainLo = computed(() => autoClimits.value?.cmin ?? colorScale.value.satMin);
const colorDomainHi = computed(() => autoClimits.value?.cmax ?? colorScale.value.satMax);
const colorHistogram = ref<Histogram | null>(null);
function openLive() {
	const q = new URLSearchParams({ colormap: w.plot.colormap, pointSize: String(w.plot.pointSize), frmAxis: w.plot.frmAxis, stride: String(w.plot.liveFrmStride) });
	window.open(appUrl(`/live/frm?${q}`), '_blank', 'noopener,width=1200,height=1000');
}
</script>

<template>
	<div class="frm-panel">
		<div class="frm-controls">
			<div class="segmode axis-seg">
				<button class="segbtn fx" :class="{ on: w.plot.frmAxis === 'Fx' }" @click="w.plot.frmAxis = 'Fx'">Fx</button>
				<button class="segbtn fy" :class="{ on: w.plot.frmAxis === 'Fy' }" @click="w.plot.frmAxis = 'Fy'">Fy</button>
				<button class="segbtn fz" :class="{ on: w.plot.frmAxis === 'Fz' }" @click="w.plot.frmAxis = 'Fz'">Fz</button>
			</div>
			<!-- Point size (folded in from the old Plot Options panel); colormap now lives in the
				 colour-scale editor below. -->
			<input class="psize" type="range" min="1" max="5" step="0.1" v-model.number="w.plot.pointSize" :title="`Point size ${w.plot.pointSize.toFixed(1)}`" />
			<select v-if="!w.isDone.value" class="cmap" v-model.number="w.plot.liveFrmStride"
				title="Live map decimation — keep every Nth point. Raise this for long/dense cuts to keep the map responsive and under its point cap.">
				<option v-for="s in STRIDES" :key="s" :value="s">{{ s === 1 ? 'full res' : `1 / ${s}` }}</option>
			</select>
			<button class="btn icon sm" :class="{ on: editorOpen }" :aria-pressed="editorOpen" title="Colour scale editor" @click="editorOpen = !editorOpen">
				<span class="material-symbols-rounded">palette</span>
			</button>
			<button class="btn icon sm" title="Pop out to a new window (second monitor) — open before Start" @click="openLive">
				<span class="material-symbols-rounded">open_in_new</span>
			</button>
		</div>
		<ColorScaleEditor v-if="editorOpen" class="cscale-editor" :color-scale="colorScale" @update:color-scale="onColorScaleUpdate"
			:locked="locked" @update:locked="locked = $event" :domain-lo="colorDomainLo" :domain-hi="colorDomainHi"
			:histogram="colorHistogram" :unit="`${w.plot.frmAxis} (N)`" />
		<div class="frm-body">
		<FrmCloud v-if="w.isDone.value && w.finishedCache.value" cache-file-id="" :cache-override="w.finishedCache.value"
			:axis="w.plot.frmAxis" :feed="w.finishedCache.value.feed" :diam="w.finishedCache.value.diam"
			:inner-diam="w.mode.value === 'playback' ? (w.replay.innerDiam ?? 0) : w.cfg.inner_diam"
			speed-mode="measured" :rpm="w.cfg.rpm" :vc="0" :time-scale="1" :ppr="w.cfg.ppr"
			:crop-start-sec="w.finishedCache.value.csSec" :crop-end-sec="w.finishedCache.value.ceSec"
			:stride="1" :gridding="false" :grid-n="600" :point-size="w.plot.pointSize" :color-scale="colorScale"
			pane-label="captured" @climits="onClimits" @histogram="colorHistogram = $event" />
		<!-- diam is only the empty-canvas fallback (LiveFrm auto-fits to the real point bounds), but
			 in playback it should still describe the cut being played, not the recording form. -->
		<LiveFrm v-else :client="w.client" :diam="w.mode.value === 'playback' ? (w.replay.diam || w.cfg.diam) : w.cfg.diam"
			:color-scale="colorScale" :point-size="w.plot.pointSize" :point-stride="w.plot.liveFrmStride" :axis="w.plot.frmAxis"
			@climits="onClimits" @histogram="colorHistogram = $event" />
		</div>
	</div>
</template>

<style scoped>
.frm-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
.frm-controls { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
.axis-seg { margin-right: auto; }
.cmap { padding: 5px 7px; font-size: var(--fs-sm); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; }
.psize { width: 84px; accent-color: var(--accent); }
.cscale-editor { padding: 8px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.frm-body { flex: 1; min-height: 0; }
.frm-body > * { height: 100%; }
.loading { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); }
</style>
