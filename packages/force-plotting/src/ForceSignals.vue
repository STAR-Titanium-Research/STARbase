<script setup lang="ts">
/*
 * The Signals group: a lid with the mode pill (Force, FFT, Power, Spectrogram, Waterfall slide out of it), LIVE,
 * the legend chips that pick the channels, zoom tools and a menu; then Fx, Fy and Fz as three charts sharing
 * the height and ONE time axis (its labels only under the bottom chart, the radius axis only over the top
 * one). In Force mode a bar under the lid compares other cuts against this one.
 */
import { computed, ref } from 'vue';
import ForceChart from './ForceChart.vue';
import ForcePanel from './ForcePanel.vue';
import PlotModeFlyout from './PlotModeFlyout.vue';
import SpectrumView from './SpectrumView.vue';
import { chainActive } from './filterChain';
import { useForceCtx } from './forceCtx';
import type { RPanel } from './forceLayout';

const props = defineProps<{ item: RPanel; canClose?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { AXES, AXIS_COLOR, CHART_MODES, chartMode, effectiveMode, isSpectral, liveOn, detail, loadingDetail, axis,
	cropDirty, cropSavePrompt, cropSaving, cropSavedMsg, saveCropAsOfficial, linkMsg,
	rectZoomTool, zoomed, resetZoom, zoomStart, zoomEnd, onChartZoom, toggleItemAxis, radialFetchBusy, chartsFor, hoverSource, hoverIndex, onCropEdit, markTime, openChartMenu,
	fftChain, fftFiltered, filterFftOverlay, cacheMeanRpm, specChain, activeStages, openPanel,
	compareOpen, compareItems, compareRefId, compareBusy, comparePickerOpen, compareCandidates, addCompare, removeCompare, clearCompare, toggleCompareRef, compareRefLabel,
	diffOn, diffResult, diffSpark, DIFF_W, DIFF_H, fmtDelta, sampleOf, fmtDate, openMenu } = useForceCtx();

const charts = computed(() => chartsFor.value(props.item));
const spectral = computed(() => ['fft', 'psd'].includes(chartMode.value));
const filterBands = ref(true);   // "Filter bands" chip: the stop bands of the active chain on the spectra
const selected = (a: string) => (props.item.channels || AXES.value).includes(a);

function more(ev: MouseEvent) {
	const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
	openMenu.value(r.left, r.bottom + 4, [
		{ label: compareOpen.value ? 'Hide the compare bar' : 'Compare with other cuts…', disabled: effectiveMode.value !== 'force', hint: 'Only in Force mode', run: () => { compareOpen.value = !compareOpen.value; } },
		{ label: 'Reset zoom', disabled: !zoomed.value, hint: 'Not zoomed', run: resetZoom.value },
		{ label: 'Close panel', disabled: props.canClose === false, hint: 'The last panel stays', run: () => emit('close') },
	]);
}
</script>

<template>
	<ForcePanel :closable="false">
		<template #title>
			<span class="stitle"><v-icon name="insights" x-small /><PlotModeFlyout v-model="chartMode" :modes="CHART_MODES" />
				<span v-if="liveOn" class="fp-badge blue">LIVE</span>
				<template v-if="liveOn && (cropDirty || cropSavePrompt || cropSavedMsg)">
					<button v-if="!cropSavePrompt && !cropSavedMsg" class="fp-btn" title="Persist this crop as the operation's official crop window" @click.stop="cropSavePrompt = true">Save crop</button>
					<span v-if="cropSavePrompt" class="confirm" @click.stop>
						Save as official crop?
						<button class="fp-btn primary" :disabled="cropSaving" @click="saveCropAsOfficial">{{ cropSaving ? '…' : 'Save' }}</button>
						<button class="fp-btn" :disabled="cropSaving" @click="cropSavePrompt = false">Cancel</button>
					</span>
					<span v-if="cropSavedMsg" class="fp-badge green">{{ cropSavedMsg }}</span>
				</template>
				<span v-if="linkMsg" class="fp-badge green">{{ linkMsg }}</span>
			</span>
		</template>
		<template #lid>
			<span class="chips">
				<button v-if="!spectral && activeStages" class="fp-chipbtn on" :title="`${activeStages} filter stage${activeStages === 1 ? '' : 's'} on — open Signal filters`" @click="openPanel = 'filters'"><v-icon name="filter_alt" x-small /> {{ activeStages }}</button>
				<button v-for="a in AXES" :key="a" class="fp-chipbtn" :class="{ on: selected(a) }" :style="{ '--key': AXIS_COLOR[a] }" :aria-pressed="selected(a)" :title="`Show ${a} in this panel`" @click="toggleItemAxis(item, a)"><span class="key"></span>{{ a }}</button>
				<button v-if="effectiveMode === 'force'" class="fp-chipbtn" :class="{ on: item.rpm }" :aria-pressed="!!item.rpm" title="Show the spindle speed under the forces" @click="item.rpm = !item.rpm"><span class="key"></span>RPM</button>
				<button v-if="spectral" class="fp-chipbtn" :class="{ on: filterBands }" :aria-pressed="filterBands" :disabled="!chainActive(specChain)" :title="chainActive(specChain) ? 'Shade the stop bands of the signal filters' : 'No signal filter is on'" @click="filterBands = !filterBands"><span class="key"></span>Filter bands</button>
				<span v-if="effectiveMode === 'force' && radialFetchBusy" class="fp-dim hint">loading radial…</span>
			</span>
		</template>
		<template #tools>
			<button class="fp-btn icon" :class="{ on: rectZoomTool }" :aria-pressed="rectZoomTool" title="Rectangular zoom — drag a box on any graph" aria-label="Rectangular zoom" @click="rectZoomTool = !rectZoomTool"><v-icon name="crop_free" x-small /></button>
			<button class="fp-btn icon" title="Reset zoom" aria-label="Reset zoom" :disabled="!zoomed" @click="resetZoom"><v-icon name="restart_alt" x-small /></button>
			<button class="fp-btn icon" title="More" aria-label="More" aria-haspopup="menu" @click.stop="more"><v-icon name="more_horiz" x-small /></button>
		</template>

		<!-- Multi-cut comparison. Force mode only: overlaying spectra or spectrograms from different cuts is not readable, and the wear question this answers is a time-domain one. -->
		<div v-if="detail && effectiveMode === 'force' && (compareOpen || compareItems.length)" class="cmp">
			<span class="label"><v-icon name="stacked_line_chart" x-small /> Compare</span>
			<span v-for="c in compareItems" :key="c.id" class="cmp-chip" :style="{ borderColor: c.color }">
				<span class="swatch" :style="{ background: c.color }"></span>{{ c.label }}
				<button class="ref" :class="{ on: compareRefId === c.id }" :aria-pressed="compareRefId === c.id"
					:title="compareRefId === c.id ? 'Reference for Difference (click to unset)' : 'Use as the reference for Difference'" @click="toggleCompareRef(c.id)">ref</button>
				<button class="x" title="Remove from comparison" aria-label="Remove from comparison" @click="removeCompare(c.id)">×</button>
			</span>
			<span v-if="compareBusy" class="fp-dim hint">loading…</span>
			<div class="add">
				<button class="fp-btn" :disabled="!compareCandidates.length" :title="compareCandidates.length ? 'Overlay another cut' : 'No other operations in the current list'" @click.stop="comparePickerOpen = !comparePickerOpen">+ Add cut</button>
				<div v-if="comparePickerOpen" class="menu" @click.stop>
					<button v-for="o in compareCandidates.slice(0, 40)" :key="o.id" @click="addCompare(o)">
						<span class="fp-code">{{ o.operation_id?.pass_code || sampleOf(o)?.sample_code || o.id }}</span>
						<span class="fp-dim">{{ fmtDate(o.operation_id?.operation_date) }}</span>
					</button>
				</div>
			</div>
			<button v-if="compareItems.length" class="fp-btn" title="Clear all comparisons" @click="clearCompare">Clear</button>
			<button v-if="compareItems.length" class="fp-btn" :class="{ on: diffOn }" :disabled="!compareRefId" :aria-pressed="diffOn"
				:title="compareRefId ? `Show ${axis} of this cut minus ${compareRefLabel}` : 'Mark a cut as ref first'" @click="diffOn = !diffOn">Difference</button>
		</div>
		<div v-if="diffOn && compareRefId && chartMode === 'force'" class="diff">
			<template v-if="diffResult && diffSpark">
				<svg :viewBox="`0 0 ${DIFF_W} ${DIFF_H}`" :width="DIFF_W" :height="DIFF_H" role="img" :aria-label="`${axis} difference versus ${compareRefLabel}`">
					<line x1="0" :x2="DIFF_W" :y1="diffSpark.zeroY" :y2="diffSpark.zeroY" class="zero" />
					<path :d="diffSpark.d" fill="none" class="line" />
				</svg>
				<span class="read"><b>{{ axis }}</b> − {{ compareRefLabel }}, {{ diffSpark.t0.toFixed(1) }}–{{ diffSpark.t1.toFixed(1) }} s: mean {{ fmtDelta(diffResult.mean) }} N · RMS {{ diffResult.rms.toPrecision(3) }} N</span>
			</template>
			<span v-else class="fp-dim hint">No overlap with the reference for {{ axis }} within both cuts' crops{{ zoomed ? ' and the zoom' : '' }}.</span>
		</div>

		<div v-if="!detail" class="fp-empty">Select an operation to view its signals</div>
		<div v-else-if="isSpectral" class="charts">
			<SpectrumView v-for="a in AXES.filter(selected)" :key="a" :cache-file-id="detail.live_cache_file"
				:chain="specChain" :axis="a" :mode="(chartMode as 'psd' | 'spectrogram' | 'waterfall')" :color="AXIS_COLOR[a]" :rpm="cacheMeanRpm" :filter-bands="filterBands" />
		</div>
		<div v-else class="charts" :class="{ switching: loadingDetail }" :aria-busy="loadingDetail">
			<ForceChart v-for="(c, i) in charts" v-bind="c" :key="c.key" :hover="hoverSource" @hover="hoverIndex = $event"
				:x-labels="i === charts.length - 1" :top-axis="i === 0"
				:crop-editable="c.kind === 'env'" :active="c.key === axis"
				:overlay="fftFiltered(c) ? filterFftOverlay : null"
				:filter-chain="c.kind === 'line' ? fftChain : null" :filter-bands="filterBands" :rpm="cacheMeanRpm"
				:view-start="zoomStart" :view-end="zoomEnd" :zoom-tool="rectZoomTool" @zoom="onChartZoom"
				@update:crop-start="onCropEdit('start', $event)" @update:crop-end="onCropEdit('end', $event)"
				:mark-x="c.kind === 'env' && chartMode === 'force' ? markTime : null" menu @chartmenu="openChartMenu" />
		</div>
	</ForcePanel>
</template>

<style scoped>
.stitle { flex: 1 1 auto; min-width: 0; display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.confirm { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs, 11px); font-weight: 700; }
.chips { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.hint { font-size: var(--fs-xs, 11px); font-weight: 400; }

.cmp { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--fp-line); }
.cmp .label { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs, 11px); font-weight: 700; color: var(--fp-dim); }
.cmp-chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 4px 1px 8px; border: 1px solid; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 700; }
.cmp-chip .swatch { width: 9px; height: 3px; border-radius: 2px; }
.cmp-chip button { border: 0; background: none; cursor: pointer; color: inherit; font: inherit; padding: 0 3px; line-height: 1.3; }
.cmp-chip .ref { border: 1px solid currentColor; border-radius: 4px; font-size: 10px; font-weight: 700; opacity: 0.6; text-transform: uppercase; }
.cmp-chip .ref.on { opacity: 1; box-shadow: inset 0 0 0 1px currentColor; }
.cmp-chip button:focus-visible { outline: 2px solid var(--fp-accent); outline-offset: 1px; }
.add { position: relative; }
.menu { position: absolute; top: 32px; left: 0; z-index: 40; min-width: 200px; max-height: 280px; overflow: auto; padding: 4px; background: var(--theme--background); border: 1px solid var(--fp-line); border-radius: 9px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
.menu button { display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 6px 8px; background: transparent; border: 0; border-radius: 6px; cursor: pointer; text-align: left; color: inherit; font: inherit; font-size: var(--fs-sm, 12px); }
.menu button:hover { background: var(--fp-tile); }
.diff { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 12px 6px; font-size: var(--fs-xs, 11px); }
.diff svg { flex: none; max-width: 100%; border: 1px solid var(--fp-line); border-radius: 4px; background: var(--plot-bg, transparent); }
.diff .zero { stroke: var(--d1-axis, var(--fp-dim)); stroke-width: 1; stroke-dasharray: 3 3; }
.diff .line { stroke: var(--theme--foreground); stroke-width: 1.2; }
.diff .read { font-variant-numeric: tabular-nums; }

/* the three charts share the height; each can shrink to its minimum before the group scrolls */
.charts { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px; overflow-y: auto; overflow-x: hidden; }
.charts > * { flex: 1 1 0; }
.charts.switching { opacity: 0.45; pointer-events: none; transition: opacity 0.12s; }
</style>
