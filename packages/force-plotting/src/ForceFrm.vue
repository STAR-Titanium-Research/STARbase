<script setup lang="ts">
/*
 * The force-revolution map panel (the centre column by default). Its lid is the FRM bar: what is shown
 * (Lite FRM, how many of the points), Figure | Lite | Full, the view (2D or a force on Z), download, the
 * channel (Fx Fy Fz) and close. The body is the map itself: the prerendered figure, the interactive Lite
 * cloud (alone, or raw next to filtered while the filters are tuned) or the Full octree.
 */
import { computed } from 'vue';
import ForcePanel from './ForcePanel.vue';
import FrmCloud from './FrmCloud.vue';
import FrmOctree from './FrmOctree.vue';
import LoadingOverlay from './LoadingOverlay.vue';
import { chainSummary } from './filterChain';
import { useForceCtx } from './forceCtx';

const emit = defineEmits<{ (e: 'close'): void }>();

const { AXES, axis, setAxis, detail, loadingDetail, stacked, octreeOn, gridActive, liveOn, fullResPoints, displayedPoints, resolutionPct, fmtPts, gridFidelityPct,
	bakedChain, compareOn, filteredSoloOn, savedChain, workChain,
	frmMode, frmBusy, liveAvailable, chooseMode, buildingOctree, octreeAvailable, buildOctree, gridFull, gridAvailable, zSeries, zScale, downloadFrm,
	frmOctreeRef, frmCloudRef, colorScale, pointSize, octreeMinNodePx, octreeBudgetCap, octreeSampleCache, markTime, hoverTime, openPointMenu, onClimits, frmStage,
	cloudProps, rawDecimatedCache, compareView, onCloudLoaded, rendererHistogram, filteredCache, filteredColorScale, filteredAuto,
	frmLoading, frmUrl, octreeMsg, downloadMsg, frmLoadOverlay } = useForceCtx();

const title = computed(() => octreeOn.value ? (gridActive.value ? 'Full FRM · gridded' : 'Full FRM') : (liveOn.value ? 'Lite FRM' : 'FRM figure'));
const interactive = computed(() => octreeOn.value || liveOn.value);
</script>

<template>
	<ForcePanel @close="emit('close')">
		<template #title><v-icon name="fingerprint" x-small /><span>{{ title }}</span></template>
		<template #lid>
			<span v-if="interactive && fullResPoints" class="fp-chip" :title="`Displayed ${displayedPoints.toLocaleString()} of ${fullResPoints.toLocaleString()} full-resolution points`">
				{{ resolutionPct != null ? `${resolutionPct}% of ` : `${fmtPts(displayedPoints)} / ` }}{{ fmtPts(fullResPoints) }}
			</span>
			<span v-if="gridActive && gridFidelityPct != null" class="fp-badge" :class="gridFidelityPct >= 95 ? 'green' : 'yellow'"
				:title="`Interpolated-grid fidelity (hold-out-arms CV). Arm/cell ratio ${detail.grid_arm_ratio?.toFixed?.(1) ?? '—'}`">grid · fidelity ~{{ gridFidelityPct }}%</span>
			<span v-else-if="gridActive" class="fp-badge yellow" title="Fidelity could not be computed (too few arms)">grid · fidelity n/a</span>
			<span v-if="bakedChain" class="fp-badge green" :title="`Baked filters: ${chainSummary(bakedChain)}`">⚙ filtered</span>
			<span v-else-if="compareOn" class="fp-badge yellow" :title="chainSummary(workChain)">compare · preview</span>
			<span v-else-if="filteredSoloOn" class="fp-badge yellow" :title="`Lite live-filtered: ${chainSummary(savedChain)} — Full & FRM PNG still raw until baked`">filtered · Lite</span>
			<span class="fp-seg" role="group" aria-label="How the map is drawn">
				<button :aria-pressed="frmMode === 'figure'" :class="{ busy: frmBusy && frmMode === 'figure' }" :aria-busy="frmBusy && frmMode === 'figure'" title="Prerendered figure (instant)" @click="chooseMode('figure')">Figure</button>
				<button :aria-pressed="frmMode === 'lite'" :class="{ busy: frmBusy && frmMode === 'lite' }" :aria-busy="frmBusy && frmMode === 'lite'" :disabled="!liveAvailable" :title="liveAvailable ? 'Lite interactive cloud (reacts to crop/feed)' : 'No live cache — reprocess to enable'" @click="liveAvailable && chooseMode('lite')">Lite</button>
				<button :aria-pressed="frmMode === 'full'" :class="{ busy: frmBusy && frmMode === 'full' }" :aria-busy="frmBusy && frmMode === 'full'" :disabled="buildingOctree" :title="octreeAvailable ? 'Full-resolution octree (LOD-streamed)' : 'Build the full-resolution octree on the host'" @click="octreeAvailable ? chooseMode('full') : buildOctree()"><v-icon v-if="buildingOctree" name="hourglass_top" x-small /> Full</button>
			</span>
			<button v-if="frmMode === 'full'" class="fp-btn" :class="{ on: gridFull }" :aria-pressed="gridFull" :disabled="buildingOctree"
				:title="gridAvailable ? 'Interpolated-grid octree (filled surface)' : 'Build the interpolated grid on the host'" @click="gridFull = !gridFull"><v-icon name="grid_on" x-small /> Gridded</button>
			<select v-if="interactive" v-model="zSeries" class="zsel" aria-label="View" title="Drive the Z axis from a force series (3D view — drag to rotate)">
				<option value="none">2D</option>
				<option value="Fx">Z = Fx</option>
				<option value="Fy">Z = Fy</option>
				<option value="Fz">Z = Fz</option>
			</select>
			<input v-if="interactive && zSeries !== 'none'" v-model.number="zScale" type="range" class="zslider" min="0" max="2" step="0.05" aria-label="Z exaggeration" title="Z exaggeration (or a 3-finger vertical swipe on the plot)" />
		</template>
		<template #tools>
			<button v-if="detail && (liveOn || octreeOn || detail[`frm_${axis.toLowerCase()}`])" class="fp-btn icon" :title="interactive ? 'Download the current view (this zoom) as a PNG' : 'Download this FRM image'" aria-label="Download the map" @click="downloadFrm"><v-icon name="download" x-small /></button>
			<span class="fp-seg" role="group" aria-label="Channel">
				<button v-for="a in AXES" :key="a" :aria-pressed="axis === a" @click="setAxis(a)">{{ a }}</button>
			</span>
		</template>

		<div class="frm-img" :class="{ switching: loadingDetail }" :aria-busy="loadingDetail">
			<div v-if="!detail" class="fp-empty">Select an operation</div>
			<FrmOctree v-else-if="octreeOn" ref="frmOctreeRef"
				:octree-path="gridActive ? detail.grid_octree_path : detail.octree_path" :axis="axis"
				:color-scale="colorScale" :point-size="pointSize"
				:z-series="zSeries" :z-scale="zScale"
				:total-points="gridActive ? Number(detail.grid_octree_points) : (fullResPoints ?? undefined)"
				:fill="gridActive" :cell-size="Number(detail.grid_cell_mm) || 1"
				:min-node-px="octreeMinNodePx" :budget-cap="octreeBudgetCap"
				:sample-cache="octreeSampleCache" :inner-diam="Number(detail.inner_diameter) || 0" :ppr="Number(detail.pulses_per_rev) || 1"
				:mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
				@climits="onClimits" @points="displayedPoints = $event" @zscale="zScale = $event" @stage="frmStage = $event" />
			<!-- Compare mode: raw | filtered, sharing one view (linked pan/zoom) + colour scale. -->
			<div v-else-if="compareOn" class="frm-compare" :class="{ stacked }">
				<FrmCloud ref="frmCloudRef" v-bind="cloudProps" :cache-override="rawDecimatedCache" :color-scale="colorScale"
					:shared-view="compareView" pane-label="raw" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
					@loaded="onCloudLoaded" @climits="onClimits" @histogram="rendererHistogram = $event" @points="displayedPoints = $event" @stage="frmStage = $event" />
				<FrmCloud v-bind="cloudProps" :cache-override="filteredCache" :color-scale="filteredColorScale"
					:shared-view="compareView" pane-label="filtered" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
					@climits="filteredAuto = $event" />
			</div>
			<FrmCloud v-else-if="filteredSoloOn" ref="frmCloudRef" v-bind="cloudProps" :cache-override="filteredCache" :color-scale="colorScale" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
				:z-series="zSeries" :z-scale="zScale"
				@loaded="onCloudLoaded" @climits="onClimits" @histogram="rendererHistogram = $event" @points="displayedPoints = $event"
				@zscale="zScale = $event" @stage="frmStage = $event" />
			<FrmCloud v-else-if="liveOn" ref="frmCloudRef" v-bind="cloudProps" :color-scale="colorScale" :mark-time="markTime" :hover-time="hoverTime" @pointmenu="openPointMenu"
				:z-series="zSeries" :z-scale="zScale"
				@loaded="onCloudLoaded" @climits="onClimits" @histogram="rendererHistogram = $event" @points="displayedPoints = $event"
				@zscale="zScale = $event" @stage="frmStage = $event" />
			<span v-else-if="frmLoading" class="fig-pending" aria-hidden="true"></span>
			<img v-else-if="frmUrl" :src="frmUrl" :alt="`FRM ${axis}`" />
			<div v-else class="fp-empty">No {{ axis }} fingerprint</div>
			<div v-if="octreeMsg && !liveOn" class="msg">{{ octreeMsg }}</div>
			<div v-if="downloadMsg" class="msg" role="alert">{{ downloadMsg }}</div>
			<LoadingOverlay v-if="frmLoadOverlay" :stage="frmLoadOverlay" />
		</div>
	</ForcePanel>
</template>

<style scoped>
.zsel { font: inherit; font-size: var(--fs-sm, 12px); font-weight: 650; height: 26px; padding: 0 6px; border-radius: 8px; cursor: pointer; border: 1px solid var(--theme--border-color); background: var(--fp-surface); color: var(--theme--foreground); }
.zslider { width: 70px; accent-color: var(--fp-accent); vertical-align: middle; cursor: pointer; }
.frm-img { position: relative; flex: 1 1 auto; display: flex; align-items: center; justify-content: center; min-width: 0; min-height: 220px; overflow: hidden; }
.frm-img img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
.frm-img.switching { opacity: 0.45; pointer-events: none; transition: opacity 0.12s; }
.frm-img > .frm-cloud, .frm-img > .frm-octree { align-self: stretch; }
/* compare: two square viewports sharing the FRM area (side by side; stacked on a phone) */
.frm-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; height: 100%; min-height: 0; }
.frm-compare.stacked { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
.frm-compare > * { min-width: 0; min-height: 0; }
.msg { position: absolute; left: 8px; right: 8px; bottom: 8px; font-size: var(--fs-xs, 11px); font-style: italic; color: var(--fp-dim); }
</style>
