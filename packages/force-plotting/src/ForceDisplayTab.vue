<script setup lang="ts">
/*
 * Tab 2, Display: how the FRM is drawn (point size, how many points, the colour map and its limits) and the
 * on-demand full-resolution render on the host.
 */
import ColorScaleEditor from './ColorScaleEditor.vue';
import { useForceCtx } from './forceCtx';

const { liveOn, pointSize, plotStride, colorScale, locked, colorDomainLo, colorDomainHi, colorHistogram, axis,
	renderPoints, rendering, renderMsg, processFullRes } = useForceCtx();
</script>

<template>
	<div class="fp-title"><b>Display</b><span class="fp-dim">FRM colour and points</span></div>
	<div class="fp-pg"><span>Point size</span><span class="v"><input v-model.number="pointSize" type="number" step="0.2" min="0.4" max="6" aria-label="Point size" /></span></div>
	<div v-if="liveOn" class="fp-pg"><span>Show every</span><span class="v">
		<select v-model.number="plotStride" aria-label="Show every"><option :value="1">all points</option><option :value="2">2nd</option><option :value="5">5th</option><option :value="10">10th</option><option :value="25">25th</option></select>
	</span></div>
	<ColorScaleEditor v-model:color-scale="colorScale" v-model:locked="locked"
		:domain-lo="colorDomainLo" :domain-hi="colorDomainHi" :histogram="colorHistogram" :unit="`${axis} (N)`" />
	<template v-if="liveOn">
		<div class="fp-title sec"><b>Full-resolution render</b><span class="fp-dim">runs on the host</span></div>
		<div class="fp-pg"><span>Points</span><span class="v"><span class="unit-box"><input v-model.number="renderPoints" type="number" step="50000" min="1000" aria-label="Points to render" /><span class="unit">points</span></span>
			<button class="fp-btn primary" :disabled="rendering" @click="processFullRes"><v-icon :name="rendering ? 'hourglass_top' : 'memory'" x-small /> {{ rendering ? 'Rendering…' : 'Process' }}</button>
		</span></div>
		<div v-if="renderMsg" class="fp-note">{{ renderMsg }}</div>
	</template>
</template>

<style scoped>
.sec { margin-top: 14px; }
</style>
