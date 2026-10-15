<script setup lang="ts">
// The interactive 3D view of one surface scan: orbit and zoom, a vertical-exaggeration slider, colour by height,
// and a legend with the height range in micrometres. It fetches the height grid and its description from the
// d1-surface-scan endpoint as the signed-in user, and hands them to the scene (surfaceScene.ts, loaded with
// import() so three.js stays out of the entry chunk). The GPU does the shading; this component is the frame
// around it. Without WebGL it says so and still shows the facts.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { LoadState, useExplorerHost, useRequestGate } from '@d1/ui';
import { hasWebGL } from '../../tooling/stage/webgl';
import { fetchGrid, fetchMeta, scanErrorText } from '../scanApi';
import { rampCss } from './colourRamp';
import { prepareScan, type PreparedScan } from './prepareScan';
import {
	exaggerationToSlider, formatExaggeration, formatMicrometres, pitchText, sizeText, SLIDER_STEPS, sliderToExaggeration,
} from './scanLayout';
import type { SurfaceScene } from './surfaceScene'; // type only: erased, three.js is not imported here

const props = defineProps<{ scanId: string; title?: string }>();

const host = useExplorerHost();
const gate = useRequestGate();

type Phase = 'loading' | 'error' | 'no-webgl' | 'ready';
const phase = ref<Phase>('loading');
const error = ref('');
const prepared = ref<PreparedScan | null>(null);
const sceneError = ref('');
const sceneLost = ref(false);
const starting = ref(false);

const slider = ref(0);
const colour = ref(true);
const exaggeration = computed(() => sliderToExaggeration(slider.value));

const canvasEl = ref<HTMLCanvasElement | null>(null);
const stageEl = ref<HTMLElement | null>(null);
// A new canvas element for every scene: a context that was lost or force-released cannot be reused.
const canvasKey = ref(0);

let scene: SurfaceScene | null = null;
let startToken = 0;
let observer: ResizeObserver | null = null;

async function load(): Promise<void> {
	const token = gate.begin();
	stopScene();
	phase.value = 'loading';
	error.value = '';
	prepared.value = null;
	try {
		const meta = await fetchMeta(host.api, props.scanId);
		const grid = await fetchGrid(host.api, props.scanId, meta);
		if (!gate.isCurrent(token)) return;
		const p = prepareScan(meta, grid);
		prepared.value = p;
		slider.value = exaggerationToSlider(p.initialExaggeration);
		colour.value = true;
		phase.value = hasWebGL() ? 'ready' : 'no-webgl';
	} catch (e) {
		if (!gate.isCurrent(token)) return;
		error.value = scanErrorText(e);
		phase.value = 'error';
	}
}

async function startScene(): Promise<void> {
	const mine = ++startToken;
	sceneError.value = '';
	sceneLost.value = false;
	starting.value = true;
	await nextTick(); // the canvas exists once the phase is ready
	const canvas = canvasEl.value;
	const p = prepared.value;
	if (!canvas || !p) { starting.value = false; return; }
	try {
		const mod = await import('./surfaceScene');
		if (mine !== startToken) return;
		const s = new mod.SurfaceScene(canvas, p);
		s.onContextLost(() => { sceneLost.value = true; });
		s.setExaggeration(exaggeration.value);
		s.setColourByHeight(colour.value);
		scene = s;
		observer?.disconnect();
		if (typeof ResizeObserver === 'function' && stageEl.value) {
			observer = new ResizeObserver(() => scene?.resize());
			observer.observe(stageEl.value);
		}
	} catch (e: any) {
		if (mine === startToken) sceneError.value = e?.message ? `The 3D view could not start: ${e.message}` : 'The 3D view could not start.';
	} finally {
		if (mine === startToken) starting.value = false;
	}
}

function stopScene(): void {
	startToken++;
	observer?.disconnect();
	observer = null;
	scene?.dispose();
	scene = null;
	starting.value = false;
}

function restart(): void {
	stopScene();
	canvasKey.value++;
	void startScene();
}

function resetView(): void {
	if (!prepared.value) return;
	slider.value = exaggerationToSlider(prepared.value.initialExaggeration);
	scene?.resetView();
}

watch(() => props.scanId, () => void load(), { immediate: true });
watch(phase, (p) => { if (p === 'ready') void startScene(); }, { flush: 'post' });
watch(exaggeration, (x) => scene?.setExaggeration(x));
watch(colour, (on) => scene?.setColourByHeight(on));
onBeforeUnmount(() => {
	gate.cancel();
	stopScene();
});

const legendGradient = rampCss('to top');
const facts = computed(() => {
	const p = prepared.value;
	if (!p) return [];
	const rows = [
		{ label: 'Size', value: sizeText(p.meta) },
		{ label: 'Pixel pitch', value: pitchText(p.meta) },
		{ label: 'Height range', value: `${formatMicrometres(p.range.min)} to ${formatMicrometres(p.range.max)}` },
	];
	if (p.meta.sourceFormat) rows.push({ label: 'File format', value: p.meta.sourceFormat });
	if (p.stats.missing > 0) {
		const share = Math.round((100 * p.stats.missing) / (p.stats.valid + p.stats.missing));
		rows.push({ label: 'No data', value: `${p.stats.missing.toLocaleString('en-GB')} cells (${share < 1 ? '<1' : share} %), left out of the picture` });
	}
	return rows;
});
const hint = '3D view of the surface scan. Drag to rotate, scroll or pinch to zoom.';
</script>

<template>
	<div class="ssv" data-testid="surface-scan-viewer" :data-phase="phase">
		<LoadState v-if="phase === 'loading'" loading loading-text="Loading the surface scan…" />

		<div v-else-if="phase === 'error'" class="problem" role="alert">
			<p>{{ error }}</p>
			<v-button small secondary @click="load">Try again</v-button>
		</div>

		<template v-else-if="prepared">
			<div v-if="phase === 'no-webgl'" class="problem" role="status">
				<p>This browser cannot draw the 3D view (WebGL is off or missing). The facts of the scan are below.</p>
			</div>
			<div v-else ref="stageEl" class="stage">
				<canvas :key="canvasKey" ref="canvasEl" class="canvas" tabindex="0" role="img" :aria-label="title ? `${hint} ${title}` : hint" />
				<div v-if="starting" class="over"><v-progress-circular indeterminate small /> Preparing the 3D view…</div>
				<div v-if="sceneError" class="over problem" role="alert">
					<p>{{ sceneError }}</p>
					<v-button small secondary @click="restart">Try again</v-button>
				</div>
				<div v-else-if="sceneLost" class="over problem" role="alert">
					<p>The graphics card dropped the 3D view.</p>
					<v-button small secondary @click="restart">Draw it again</v-button>
				</div>
				<div class="legend" :class="{ plain: !colour }" data-testid="surface-scan-legend" role="group" aria-label="Height legend">
					<span class="legend-title">Height</span>
					<span class="legend-top">{{ formatMicrometres(prepared.range.max) }}</span>
					<span class="bar" :style="colour ? { background: legendGradient } : undefined" aria-hidden="true" />
					<span class="legend-bottom">{{ formatMicrometres(prepared.range.min) }}</span>
				</div>
			</div>

			<div v-if="phase === 'ready'" class="controls">
				<label class="ctl slide">
					<span>Vertical exaggeration</span>
					<input v-model.number="slider" type="range" min="0" :max="SLIDER_STEPS" step="1" aria-label="Vertical exaggeration" :aria-valuetext="formatExaggeration(exaggeration)" />
					<output class="num">{{ formatExaggeration(exaggeration) }}</output>
				</label>
				<label class="ctl"><input v-model="colour" type="checkbox" /> <span>Colour by height</span></label>
				<v-button small secondary @click="resetView">Reset view</v-button>
			</div>

			<dl class="facts">
				<div v-for="f in facts" :key="f.label"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></div>
			</dl>
		</template>
	</div>
</template>

<style scoped>
.ssv { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.stage {
	position: relative;
	height: clamp(300px, 56vh, 520px);
	border-radius: var(--d1-radius, 12px);
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	background: var(--d1-tile, var(--theme--background-subdued));
	overflow: hidden;
}
.canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.canvas:active { cursor: grabbing; }
.canvas:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.over { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; flex-direction: column; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); pointer-events: none; }
.over.problem { background: color-mix(in srgb, var(--d1-tile, var(--theme--background-subdued)) 88%, transparent); pointer-events: auto; }
.problem { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; font-size: var(--fs-sm, 12px); }
.problem p { margin: 0; }
.over.problem p { color: var(--d1-bad, var(--theme--danger)); }
.legend {
	position: absolute; top: 12px; right: 12px;
	display: grid; grid-template-columns: 14px auto; grid-template-rows: auto auto 1fr auto; column-gap: 8px; row-gap: 2px;
	padding: 8px 10px; border-radius: 8px; font-size: var(--fs-xs, 11px); font-variant-numeric: tabular-nums;
	background: color-mix(in srgb, var(--d1-surface, var(--theme--background)) 86%, transparent);
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	color: var(--theme--foreground);
	pointer-events: none;
}
.legend-title { grid-column: 1 / 3; font-weight: 650; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.legend-top { grid-column: 2; grid-row: 2; }
.legend-bottom { grid-column: 2; grid-row: 4; }
.bar { grid-column: 1; grid-row: 2 / 5; width: 14px; min-height: 96px; border-radius: 3px; background: linear-gradient(to top, #4a4d52, #b9bcc2); }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; }
.ctl { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-sm, 12px); }
.ctl.slide { flex: 1 1 280px; min-width: 0; }
.ctl.slide input[type='range'] { flex: 1 1 120px; min-width: 80px; accent-color: var(--d1-accent, var(--theme--primary)); }
.num { min-width: 4ch; text-align: right; font-weight: 650; font-variant-numeric: tabular-nums; }
.facts { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 0; font-size: var(--fs-sm, 12px); }
.facts > div { display: flex; gap: 6px; }
.facts dt { color: var(--d1-dim, var(--theme--foreground-subdued)); }
.facts dt::after { content: ':'; }
.facts dd { margin: 0; }
</style>
