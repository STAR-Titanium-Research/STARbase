<script setup lang="ts">
// Polar panel: torque/force vs spindle angle, once a cut is finished or replayed. Mirrors
// FrmPanel.vue's toolbar shape. See
// docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md #6.
//
// Live-while-recording is out of scope here: this only renders once w.finishedCache exists
// (the same gate FrmPanel.vue uses for its FrmCloud branch), not while a cut is in progress.
import { computed } from 'vue';
import { useWorkspace } from '../workspace';
import { PolarPlot, COLORMAPS, colormapLabel, type PolarParams } from '@d1/force-plotting';
import { appUrl } from '../../appUrl';

const w = useWorkspace();
const RADII = ['Fz', 'Fxy', 'Mz'] as const;
const SOURCES = [
	{ key: 'tacho', label: 'Tacho' },
	{ key: 'force_vector', label: 'atan2(Fy,Fx)' },
] as const;

const cache = computed(() => w.finishedCache.value);

const params = computed<PolarParams>(() => ({
	radius: w.plot.polarRadius,
	angle: {
		source: w.plot.polarAngleSource, ppr: w.cfg.ppr, offsetDeg: 0, direction: 1,
		engagementN: 5,
	},
	window: {
		cropStartSec: cache.value?.csSec ?? 0,
		cropEndSec: cache.value?.ceSec ?? 1e9,
		stride: 1,
	},
	bins: w.plot.polarBins,
}));

function openLive() {
	const q = new URLSearchParams({
		radius: w.plot.polarRadius, angle: w.plot.polarAngleSource,
		colormap: w.plot.colormap, pointSize: String(w.plot.pointSize),
	});
	window.open(appUrl(`/live/polar?${q}`), '_blank', 'noopener,width=1000,height=1000');
}
</script>

<template>
	<div class="frm-panel">
		<div class="frm-controls">
			<div class="segmode radius-seg">
				<button v-for="r in RADII" :key="r" class="segbtn" :class="{ on: w.plot.polarRadius === r }" @click="w.plot.polarRadius = r">{{ r }}</button>
			</div>
			<select class="cmap" v-model="w.plot.polarAngleSource" title="Angle source">
				<option v-for="s in SOURCES" :key="s.key" :value="s.key">{{ s.label }}</option>
			</select>
			<!-- Driven off COLORMAPS rather than a hardcoded list: w.plot.colormap is shared with the
				 FRM colour-scale editor, so a ramp picked there must be selectable (and spelled the
				 same way) here too, or this select renders an unmatched/blank value. -->
			<select class="cmap" v-model="w.plot.colormap" title="Colormap">
				<option v-for="m in Object.keys(COLORMAPS)" :key="m" :value="m">{{ colormapLabel(m) }}</option>
			</select>
			<button class="btn icon sm" title="Pop out to a new window" @click="openLive">
				<span class="material-symbols-rounded">open_in_new</span>
			</button>
		</div>
		<div class="frm-body">
			<PolarPlot v-if="cache" :cache="cache" :params="params" :colormap="w.plot.colormap" :point-size="w.plot.pointSize" />
			<div v-else class="loading">Finish or replay a cut to see its polar plot.</div>
		</div>
	</div>
</template>

<style scoped>
.frm-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
.frm-controls { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
.radius-seg { margin-right: auto; }
.cmap { padding: 5px 7px; font-size: var(--fs-sm); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; }
.frm-body { flex: 1; min-height: 0; }
.frm-body > * { height: 100%; }
.loading { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); text-align: center; padding: 12px; }
</style>
