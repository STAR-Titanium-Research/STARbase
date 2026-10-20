<script setup lang="ts">
/*
 * Tab 5, Cutting metrics: resultant force, Fc / Ff / Fp, cutting speed, power and specific cutting energy
 * over the crop window (cuttingMetrics.ts). It needs the statistics (same window, same cache), so it shows a
 * hint until those are computed.
 */
import { AXIS_MAPS, formatAxisMap } from './cuttingMetrics';
import { useForceCtx } from './forceCtx';

const { cutting, cutVal, cutTip, cuttingMapText, axisMapSubtype, axisMapSel, onAxisMapChange, AXIS_MAP_STANDARD } = useForceCtx();
</script>

<template>
	<div class="fp-title"><b>Cutting metrics</b><span class="fp-dim">from the crop window</span></div>
	<div v-if="!cutting" class="fp-empty">Compute Signal statistics first (same crop window).</div>
	<template v-else>
		<table class="cut">
			<thead><tr><th></th><th>Mean</th><th>Peak</th></tr></thead>
			<tbody>
				<tr><td>Resultant |F| <span class="fp-dim">N</span></td>
					<td :title="cutTip(cutting.resultant.mean, '|F| = √(Fx² + Fy² + Fz²) per sample, mean over the window')">{{ cutVal(cutting.resultant.mean) }}</td>
					<td :title="cutTip(cutting.resultant.peak, '|F| = √(Fx² + Fy² + Fz²) per sample, maximum over the window')">{{ cutVal(cutting.resultant.peak) }}</td></tr>
				<tr v-for="r in (['Fc', 'Ff', 'Fp'] as const)" :key="r">
					<td>{{ r }} <span class="fp-dim">N ({{ r === 'Fc' ? 'cutting' : r === 'Ff' ? 'feed' : 'passive' }}, {{ cutting.axisMap[r] }})</span></td>
					<td :title="cutTip(cutting[r].mean, `${r} = |mean ${cutting.axisMap[r]}| over the window. ${cuttingMapText}`)">{{ cutVal(cutting[r].mean) }}</td>
					<td :title="cutTip(cutting[r].peak, `${r} peak = max |${cutting.axisMap[r]}| over the window. ${cuttingMapText}`)">{{ cutVal(cutting[r].peak) }}</td></tr>
			</tbody>
		</table>
		<div class="fp-pg" :title="cutTip(cutting.vcMPerMin, 'vc = π · D · n / 1000 [m/min], D in mm at the window midpoint (the disc shrinks by 2·f per rev), n = measured mean RPM in the window')"><span>Cutting speed vc</span><span class="v">{{ cutVal(cutting.vcMPerMin) }} <span class="fp-dim">m/min</span></span></div>
		<div class="fp-pg" :title="cutTip(cutting.pcW, 'Pc = Fc · vc / 60 [W] (vc in m/min), mean Fc. Feed-force power neglected.')"><span>Cutting power Pc</span><span class="v">{{ cutVal(cutting.pcW) }} <span class="fp-dim">W</span></span></div>
		<div class="fp-pg" :title="cutTip(cutting.kcMPa, 'kc = Fc / (ap · f) [N/mm² = MPa], mean Fc, ap = axial depth of cut, f = feed per rev')"><span>Specific cutting energy kc</span><span class="v">{{ cutVal(cutting.kcMPa, 0) }} <span class="fp-dim">N/mm²</span></span></div>
		<p v-if="cutting.pcW.value == null || cutting.kcMPa.value == null" class="fp-note">
			<template v-if="cutting.Fc.mean.value == null">{{ cutting.Fc.mean.reason }}.</template>
			<template v-else>
				<template v-if="cutting.pcW.value == null">Pc: {{ cutting.pcW.reason }}. </template>
				<template v-if="cutting.kcMPa.value == null">kc: {{ cutting.kcMPa.reason }}.</template>
			</template>
		</p>
		<div class="fp-pg"><span>Axis mapping<template v-if="axisMapSubtype"> for {{ axisMapSubtype }}</template></span>
			<span class="v"><select v-model="axisMapSel" :title="cuttingMapText" aria-label="Axis mapping" @change="onAxisMapChange">
				<option v-for="a in AXIS_MAPS" :key="a.key" :value="a.key">{{ formatAxisMap(a.map) }}</option>
			</select></span>
		</div>
		<p class="fp-note">Depends on workholding and operation, so it is remembered per operation type. Standard: {{ AXIS_MAP_STANDARD }}.</p>
		<p class="fp-note">Over the crop window. Values use the operation's feed and depth of cut (else the capture's), the Diameter control and the measured mean RPM. Hover a value for its formula.</p>
	</template>
</template>

<style scoped>
.cut { width: 100%; border-collapse: collapse; margin: 6px 0 4px; font-size: var(--fs-sm, 12px); }
.cut th { text-align: right; padding: 2px 6px; font-size: var(--fs-xs, 11px); color: var(--fp-dim); font-weight: 600; }
.cut td { text-align: right; padding: 4px 6px; font-variant-numeric: tabular-nums; border-top: 1px solid var(--fp-line); }
.cut td:first-child { text-align: left; padding-left: 0; font-weight: 600; }
</style>
