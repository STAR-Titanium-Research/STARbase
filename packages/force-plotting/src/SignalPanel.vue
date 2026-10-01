<script setup lang="ts">
// Record-tab-style channel picker for the Diagnostics Workbench's Signal panel (Phase H
// slice 4). Previously a fixed "anomaly z-score along the cut" chart with no controls at
// all -- this adds a Fp/Fc/Ff chip row (frame_transform.channel is a single-valued recipe
// param; picking a chip IS editing it, exactly like expanding frame_transform in the
// Pipeline panel and changing the same dropdown) plus an opt-in "All channels" mode that
// pre-fetches and caches all three so flipping between them for comparison is instant.
//
// "All channels" is possible without a rebake because base.d1an now carries all three
// frame_transform signals (scripts/diag/runner.py::base_columns_all_channels) -- /preview
// can genuinely show fc or ff for an already-baked cut, not just fp.
import { computed, ref, watch } from 'vue';
import ForceChart from './ForceChart.vue';
import InfoTip from './InfoTip.vue';
import { fetchDiagPreview } from './diagPreview';
import { workingSetFromD1an } from './selection';
import type { Selection, WorkingSet } from './selection';
import { STEP_META, type Recipe } from './recipeChannels';
import { PANEL_HELP } from './diagHelp';
import { layersForRequest, type DiagLayer } from './diagLayers';
import { bucketEnvelope } from './liveCache';

type Channel = 'fp' | 'fc' | 'ff';

const CHANNEL_OPTIONS = computed(() =>
	(STEP_META.frame_transform.params.find((p) => p.key === 'channel')?.options ?? []) as
		{ value: Channel; label: string }[]);

const props = defineProps<{
	recipe: Recipe;
	analysisId: string;
	layers: DiagLayer[];
	recipeValid: boolean;
	/** the workbench's current WorkingSet -- whichever channel recipe.frame_transform.channel
	 *  already names, exactly what the Signal chart showed before this panel existed. */
	activeWorkingSet: WorkingSet | null;
	selection: Selection;
}>();
const emit = defineEmits<{
	(e: 'update:recipe', r: Recipe): void;
	(e: 'update:selection', s: Selection): void;
}>();

const currentChannel = computed<Channel>(() => {
	const s = props.recipe.steps.find((x) => x.op === 'frame_transform');
	return (s?.params.channel as Channel) ?? 'fp';
});

function edit(mut: (r: Recipe) => void) {
	const next = JSON.parse(JSON.stringify(props.recipe)) as Recipe;
	mut(next);
	emit('update:recipe', next);
}
function recipeForChannel(ch: Channel): Recipe {
	const next = JSON.parse(JSON.stringify(props.recipe)) as Recipe;
	const s = next.steps.find((x) => x.op === 'frame_transform');
	if (s) s.params.channel = ch;
	return next;
}

// Which channel's data is actually drawn. In normal (non-comparison) mode this always mirrors
// currentChannel/activeWorkingSet -- unchanged from the panel's pre-slice-4 behaviour.
const displayed = ref<Channel>(currentChannel.value);
watch(currentChannel, (c) => { if (!allChannelsMode.value) displayed.value = c; });

// --- "All channels": pre-fetch + cache the other two so switching is instant ---------------
const allChannelsMode = ref(false);
const cache = ref<Partial<Record<Channel, WorkingSet>>>({});
const fetching = ref<Set<Channel>>(new Set());
const fetchErr = ref<string | null>(null);

async function fetchChannel(ch: Channel) {
	if (!props.recipeValid || fetching.value.has(ch)) return;
	fetching.value = new Set([...fetching.value, ch]);
	try {
		const r = await fetchDiagPreview(
			props.analysisId, recipeForChannel(ch), null, undefined,
			props.layers.length ? layersForRequest(props.layers) : undefined,
		);
		cache.value = { ...cache.value, [ch]: workingSetFromD1an(r.attrs) };
		fetchErr.value = null;
	} catch (e: any) {
		fetchErr.value = e?.message || `failed to preview ${ch}`;
	} finally {
		const s = new Set(fetching.value);
		s.delete(ch);
		fetching.value = s;
	}
}
function refetchAll() {
	// currentChannel is whatever frame_transform.channel already names -- the workbench's own
	// preview loop keeps that one current via activeWorkingSet, so fetching it here would just
	// duplicate that request against the server LRU. Only the other two need a fetch of our own.
	for (const c of CHANNEL_OPTIONS.value) if (c.value !== currentChannel.value) fetchChannel(c.value);
}
// Debounced like the main preview loop -- a param edit while "All channels" is on would
// otherwise fire 3 extra requests per keystroke on top of the workbench's own preview call.
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefetchAll() {
	if (refetchTimer) clearTimeout(refetchTimer);
	refetchTimer = setTimeout(refetchAll, 400);
}
watch(allChannelsMode, (on) => { if (on) { displayed.value = currentChannel.value; refetchAll(); } });
watch(() => props.recipe, () => { if (allChannelsMode.value) scheduleRefetchAll(); }, { deep: true });

function selectChip(ch: Channel) {
	displayed.value = ch;
	edit((r) => {
		const s = r.steps.find((x) => x.op === 'frame_transform');
		if (s) s.params.channel = ch;
	});
	if (allChannelsMode.value && !cache.value[ch]) fetchChannel(ch);
}

const shownWS = computed<WorkingSet | null>(() => {
	// The current channel is always read live from activeWorkingSet, comparison mode or not --
	// refetchAll deliberately never populates cache[currentChannel] (see refetchAll), so relying
	// on the cache for it here would show a stale snapshot once the recipe changes again.
	if (!allChannelsMode.value || displayed.value === currentChannel.value) return props.activeWorkingSet;
	return cache.value[displayed.value] ?? null;
});

const chartData = computed(() => {
	const ws = shownWS.value;
	if (!ws) return null;
	let t = ws.t;
	let z = ws.residZ;
	if (!z.every((v) => Number.isFinite(v))) {
		const ti: number[] = []; const zi: number[] = [];
		for (let i = 0; i < ws.n; i++) if (Number.isFinite(z[i])) { ti.push(t[i]); zi.push(z[i]); }
		t = Float32Array.from(ti); z = Float32Array.from(zi);
	}
	return bucketEnvelope(t, z);
});
function onCropStart(v: number) {
	const cur = props.selection;
	const t1 = cur && cur.kind === 'time' ? cur.t1 : (shownWS.value?.t.at(-1) ?? v);
	emit('update:selection', { kind: 'time', t0: v, t1 });
}
function onCropEnd(v: number) {
	const cur = props.selection;
	const t0 = cur && cur.kind === 'time' ? cur.t0 : (shownWS.value?.t[0] ?? v);
	emit('update:selection', { kind: 'time', t0, t1: v });
}
</script>

<template>
	<div class="signal-panel">
		<div class="sig-head">
			<div class="sig-chips">
				<button
					v-for="c in CHANNEL_OPTIONS" :key="c.value" class="sig-chip"
					:class="{ on: displayed === c.value }"
					:title="c.label"
					@click="selectChip(c.value)"
				>
					{{ c.label }}
					<span v-if="allChannelsMode && fetching.has(c.value)" class="sig-spin">…</span>
				</button>
			</div>
			<button
				class="sig-allmode" :class="{ on: allChannelsMode }"
				title="Fetch and cache all three channels so switching between them is instant"
				@click="allChannelsMode = !allChannelsMode"
			>
				All channels
			</button>
			<InfoTip :text="PANEL_HELP.signal" wide placement="left" />
		</div>
		<p v-if="fetchErr" class="sig-err">{{ fetchErr }}</p>
		<ForceChart
			v-if="chartData"
			title="resid_z (σ from normal for that radius) vs time"
			kind="env" :data="chartData" color="#f59e0b" x-unit="s" y-unit="σ"
			:crop-start="selection?.kind === 'time' ? selection.t0 : null"
			:crop-end="selection?.kind === 'time' ? selection.t1 : null"
			:crop-editable="true"
			@update:crop-start="onCropStart" @update:crop-end="onCropEnd"
		/>
		<div v-else class="sig-loading">
			{{ allChannelsMode && fetching.size ? 'computing…' : 'loading…' }}
		</div>
	</div>
</template>

<style scoped>
.signal-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 4px; }
.sig-head { display: flex; align-items: center; gap: 6px; padding: 2px 2px 4px; flex-wrap: wrap; }
.sig-chips { display: flex; gap: 4px; }
.sig-chip {
	display: inline-flex; align-items: center; gap: 3px; padding: 3px 9px; font: inherit; font-size: var(--fs-xs, 11px);
	font-weight: 650; color: var(--text-dim, #94a3b8); background: var(--bg-2, #111a33);
	border: 1px solid var(--border, rgba(255,255,255,0.14)); border-radius: 999px; cursor: pointer;
}
.sig-chip.on { color: var(--accent-ink, #0b1020); background: var(--accent, #38bdf8); border-color: var(--accent, #38bdf8); }
.sig-spin { font-size: var(--fs-xs, 11px); opacity: 0.8; }
.sig-allmode {
	font: inherit; font-size: var(--fs-xs, 11px); font-weight: 650; text-transform: uppercase; letter-spacing: 0.03em;
	padding: 3px 8px; color: var(--text-dim, #94a3b8); background: none;
	border: 1px solid var(--border, rgba(255,255,255,0.14)); border-radius: 999px; cursor: pointer;
}
.sig-allmode.on { color: var(--accent, #7dd3fc); border-color: var(--accent, #38bdf8); background: color-mix(in srgb, var(--accent, #38bdf8) 14%, transparent); }
.sig-err { margin: 0; font-size: var(--fs-xs, 11px); color: var(--danger, #fca5a5); }
.sig-loading { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--text-dim, #94a3b8); font-size: var(--fs-sm, 12px); }
</style>
