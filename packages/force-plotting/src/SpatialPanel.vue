<script setup lang="ts">
// One full-resolution spatial view. Extracted from DiagnosticsWorkbench so the workbench can
// hold several side by side (each on its own channel) and so a single one can be popped out to
// its own window -- the popped-out window mounts exactly this component.
//
// It owns its own viewport state: the channel it colours by, the last full-resolution
// recompute, the framed bbox, and which op is in flight. Everything shared -- the recipe, the
// painted layers, the cross-panel selection -- comes in as props; edits go out as events.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import DiagOctreeView from './DiagOctreeView.vue';
import { defaultScale, type ColorScale } from './colorScale';
import InfoTip from './InfoTip.vue';
import { fetchViewportCompute, type ViewportResult, type ViewportStep, type ViewportOp } from './diagViewport';
import { layersForRequest, type DiagLayer } from './diagLayers';
import { CHANNEL_HELP } from './diagHelp';
import type { ChannelKey, Selection } from './selection';
import type { ChannelOption, Recipe } from './recipeChannels';

const props = withDefaults(defineProps<{
	analysisId: string;
	octreePath: string;
	recipe: Recipe;
	recipeValid: boolean;
	channelOptions: ChannelOption[];
	layers: DiagLayer[];
	activeLayerName: string | null;
	selection: Selection;
	/** paint mode: draw polygons instead of orbiting. */
	drawing: boolean;
	/** which channel this view starts on (persisted in the panel layout). */
	initialChannel?: string;
	/** hide the popout control (the popped-out window itself has nothing to pop out to). */
	noPopout?: boolean;
}>(), { initialChannel: 'residZ', noPopout: false });

const emit = defineEmits<{
	(e: 'polygon', ring: [number, number][]): void;
	(e: 'update:channel', c: string): void;
	(e: 'result', r: ViewportResult | null): void;
	(e: 'busy', v: boolean): void;
	(e: 'popout', channel: string): void;
}>();

const channel = ref<ChannelKey>((props.initialChannel as ChannelKey) || 'residZ');
watch(channel, (c) => emit('update:channel', c));

// This panel has no colour-scale editor UI yet -- always viridis, always auto-ranged from the
// octree's own per-channel data (climits), matching the exact behaviour the old hardcoded
// `:colormap="'viridis'"` + cmin/cmax-absent props had. DiagOctreeView.vue no longer auto-detects
// internally (Stage 2 moved that decision entirely to the host via climits), so seeding this from
// the climits event is required, not optional -- without it the octree would render pinned to the
// placeholder [0,1] range forever.
const colorScale = ref<ColorScale>(defaultScale(0, 1));
function onClimits(v: { cmin: number; cmax: number }) {
	colorScale.value = defaultScale(v.cmin, v.cmax);
}
// `initialChannel` is not just a seed: DiagnosticsWorkbench changes it to redirect an
// already-mounted panel (e.g. "click a step card to revert the hero view to its channel").
// Without this watch that only updated the persisted layout, never the live view.
// The `c !== channel.value` guard stops the parent's own persist-of-our-emit from looping.
watch(() => props.initialChannel, (c) => {
	if (c && c !== channel.value) channel.value = c as ChannelKey;
});

const analysisResult = ref<ViewportResult | null>(null);
const viewportBounds = ref<[number, number, number, number] | null>(null);
const viewportBusy = ref(false);
const viewportBusyOp = ref<string | null>(null);
let viewportAbort: AbortController | null = null;

watch(analysisResult, (r) => emit('result', r));
watch(viewportBusy, (b) => emit('busy', b));

const OUTPUT_OF: Record<string, ChannelKey> = {
	getis_ord: 'giStar', hdbscan: 'clusterId', grow_segmentation: 'segmentId',
	gmm_segmentation: 'gmmId',
};
const OP_OF: Partial<Record<ChannelKey, ViewportOp>> = {
	giStar: 'getis_ord', clusterId: 'hdbscan', segmentId: 'grow_segmentation',
	gmmId: 'gmm_segmentation',
};
const analysisMode = computed<'continuous' | 'categorical'>(() =>
	channel.value === 'clusterId' || channel.value === 'segmentId' || channel.value === 'gmmId'
		? 'categorical' : 'continuous');
const isolateClass = computed(() =>
	(props.selection?.kind === 'cluster' ? props.selection.id : null));

function stepParams(op: string): Record<string, unknown> {
	const s = props.recipe.steps.find((x) => x.op === op && x.on);
	return s ? { ...s.params } : {};
}
function stepInputs(op: string): Record<string, unknown> | undefined {
	const s = props.recipe.steps.find((x) => x.op === op && x.on);
	return s?.inputs as Record<string, unknown> | undefined;
}

async function runViewport(
	op: ViewportOp,
	{ focus }: { focus: boolean } = { focus: true },
) {
	if (!viewportBounds.value || !props.recipeValid) return;
	viewportAbort?.abort();
	const ac = new AbortController();
	viewportAbort = ac;
	viewportBusy.value = true;
	viewportBusyOp.value = op;
	try {
		const step: ViewportStep = { op, params: stepParams(op), inputs: stepInputs(op) };
		const r = await fetchViewportCompute(props.analysisId, viewportBounds.value, step, {
			layers: props.layers.length ? layersForRequest(props.layers) : undefined,
			signal: ac.signal,
			output: op === 'getis_ord' ? 'gi_star' : undefined,
		});
		if (ac.signal.aborted) return;
		analysisResult.value = r;
		if (focus) channel.value = OUTPUT_OF[op];
	} catch (e: unknown) {
		if (!ac.signal.aborted && (e as { name?: string })?.name !== 'AbortError') {
			err.value = (e as { message?: string })?.message || 'viewport compute failed';
		}
	} finally {
		if (viewportAbort === ac) { viewportBusy.value = false; viewportBusyOp.value = null; }
	}
}
defineExpose({ runViewport });

const err = ref<string | null>(null);

function onBounds(b: [number, number, number, number]) {
	viewportBounds.value = b;
}

watch(() => props.analysisId, () => {
	viewportAbort?.abort();
	analysisResult.value = null;
	viewportBounds.value = null;
});

// Auto Gi* on settle -- only while actually viewing Gi*.
let giTimer: ReturnType<typeof setTimeout> | null = null;
watch(viewportBounds, () => {
	const gi = props.recipe.steps.find((s) => s.op === 'getis_ord' && s.on);
	if (!gi || channel.value !== 'giStar' || !viewportBounds.value) return;
	if (giTimer) clearTimeout(giTimer);
	giTimer = setTimeout(() => runViewport('getis_ord', { focus: false }), 600);
});
// Switching to a spatial channel recomputes when the shown overlay is not that op's output.
watch(channel, (c) => {
	const op = OP_OF[c];
	if (op && analysisResult.value?.op === op) return;   // already showing this op's result
	// Switched to a non-spatial channel (residZ etc.), or to a spatial channel whose result we
	// don't hold: drop any stale spatial overlay so DiagOctreeView doesn't keep rendering it
	// -- categorical cluster ids re-interpreted as a continuous gradient under residZ, or the
	// wrong op's categorical layer.
	analysisResult.value = null;
	if (!op || !viewportBounds.value) return;
	runViewport(op, { focus: false });
});
// Re-run only when the shown step's own params change (not an unrelated recipe edit).
const activeSpatialStepKey = computed(() => {
	const op = OP_OF[channel.value];
	if (!op) return null;
	const s = props.recipe.steps.find((x) => x.op === op && x.on);
	if (!s) return null;
	const seedGeoms = op === 'grow_segmentation'
		? props.layers.filter((l) => l.role === 'seed').map((l) => [l.name, l.version, l.geometry])
		: null;
	return JSON.stringify({ params: s.params, inputs: s.inputs ?? null, seedGeoms });
});
let vpRecipeTimer: ReturnType<typeof setTimeout> | null = null;
watch(activeSpatialStepKey, () => {
	const op = OP_OF[channel.value];
	if (!op || analysisResult.value?.op !== op) return;
	if (vpRecipeTimer) clearTimeout(vpRecipeTimer);
	vpRecipeTimer = setTimeout(() => runViewport(op, { focus: false }), 500);
});
// A produced-channel deselected out from under this view falls back to resid_z.
watch(() => props.channelOptions, (opts) => {
	const cur = opts.find((o) => o.key === channel.value);
	if (cur && !cur.produced) channel.value = 'residZ';
});

onBeforeUnmount(() => {
	viewportAbort?.abort();
	if (giTimer) clearTimeout(giTimer);
	if (vpRecipeTimer) clearTimeout(vpRecipeTimer);
});
</script>

<template>
	<div class="spatial-panel">
		<DiagOctreeView
			:octree-path="octreePath"
			:channel="'residZ'"
			:color-scale="colorScale"
			:point-size="1.5"
			:selection="selection"
			:analysis-result="analysisResult"
			:analysis-mode="analysisMode"
			:isolate-class="isolateClass"
			:layers="layers"
			:active-layer-name="activeLayerName"
			:paint-mode="drawing ? 'draw' : 'off'"
			@polygon="(r) => emit('polygon', r)"
			@bounds="onBounds"
			@climits="onClimits"
		/>
		<div class="sp-bar">
			<label class="sp-field">
				<span class="sp-field-label">
					Colour by
					<InfoTip :text="CHANNEL_HELP[channel] ?? 'Per-point analysis channel.'" placement="left" />
				</span>
				<select v-model="channel" class="sp-select">
					<option v-for="o in channelOptions" :key="o.key" :value="o.key" :disabled="!o.produced">
						{{ o.label }}{{ o.produced ? '' : ' — step off' }}
					</option>
				</select>
			</label>
			<span class="sp-state">
				<template v-if="err" class="sp-err">{{ err }}</template>
				<template v-else-if="viewportBusy">computing on this view…</template>
				<template v-else-if="analysisResult">
					{{ analysisResult.n.toLocaleString() }} pts in view{{ analysisResult.ms != null ? ` · ${analysisResult.ms} ms` : '' }}
				</template>
				<template v-else-if="OP_OF[channel]">pan or zoom to compute on a region</template>
				<template v-else>baked map · whole cut</template>
			</span>
			<button v-if="!noPopout" class="sp-popout" title="Open this view in its own window (second monitor)" @click="emit('popout', channel)">
				<span class="material-symbols-rounded">open_in_new</span>
			</button>
		</div>
	</div>
</template>

<style scoped>
.spatial-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.spatial-panel > :first-child { flex: 1; min-height: 0; }
.sp-bar { flex: none; display: flex; align-items: flex-end; gap: 10px; padding: 7px 2px 2px; }
.sp-field { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sp-field-label { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs, 11px); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim, #94a3b8); }
.sp-select { width: 100%; font-size: var(--fs-sm, 12px); padding: 4px 6px; background: var(--bg-2, #111a33); color: var(--text, #e5e7eb); border: 1px solid var(--border, rgba(255,255,255,0.14)); border-radius: 6px; }
.sp-state { flex: none; font-size: var(--fs-xs, 11px); color: var(--text-dim, #94a3b8); font-variant-numeric: tabular-nums; padding-bottom: 5px; }
.sp-state .sp-err { color: var(--danger, #fca5a5); }
.sp-popout { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; background: var(--bg-2, #111a33); border: 1px solid var(--border, rgba(255,255,255,0.18)); color: var(--text-dim, #94a3b8); cursor: pointer; }
.sp-popout:hover { color: var(--accent, #38bdf8); }
.sp-popout .material-symbols-rounded { font-size: var(--icon-sm, 16px); }
</style>
