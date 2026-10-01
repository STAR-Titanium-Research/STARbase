<script setup lang="ts">
// A single Diagnostics Workbench panel in its own window — the second-monitor view. Mirrors
// the Record tab's /live/:panel pop-outs (LivePanelWindow.vue): read the target from the route, render one panel full-window.
//
// This is a VIEWER, not the editor: editing the recipe stays in the main workbench window.
// A framed region still recomputes its spatial step at full resolution here, because that
// only needs the analysis id and the step params.
//
// It is no longer a STALE viewer, though. It used to read the row once on mount and never
// hear anything again, so a recipe edit, a cluster isolation or a new painted layer in the
// main window left this one silently showing something else. It now subscribes to the
// workbench's BroadcastChannel (diagSync.ts) and mirrors it, announcing itself with `hello`
// on mount so a window opened after the last edit is never stale. It never publishes back —
// one writer keeps the model trivial.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
	SpatialPanel, DEFAULT_RECIPE, recipeChannels, openDiagSync, describeRequestFailure,
	fetchLayers, type DiagSyncChannel, type DiagLayer, type Recipe,
} from '@d1/force-plotting';
import { api } from '../directusClient';

const route = useRoute();
const analysisId = computed(() => String(route.params.analysisId || ''));
const channel = ref(String(route.query.channel || 'residZ'));

const diagPath = ref<string | null>(null);
const recipe = ref<Recipe>(DEFAULT_RECIPE);
const layers = ref<DiagLayer[]>([]);
const selection = ref<{ kind: 'cluster'; id: number } | null>(null);
const err = ref<string | null>(null);
let sync: DiagSyncChannel | null = null;
const ready = computed(() => !!diagPath.value);

const channelOptions = computed(() => recipeChannels(recipe.value));

onMounted(async () => {
	try {
		const res = await api.get(`/items/machining_force_analysis/${analysisId.value}`, {
			params: { fields: ['diag_path', 'diag_status', 'diag_recipe'] },
		});
		const row = res.data?.data;
		if (row?.diag_status !== 'done' || !row?.diag_path) {
			err.value = 'This cut has no completed bake to view.';
			return;
		}
		diagPath.value = row.diag_path;
		if (row.diag_recipe) recipe.value = row.diag_recipe as Recipe;
		document.title = `Spatial · ${row.pass_code || analysisId.value.slice(0, 8)}`;
	} catch (e: any) {
		err.value = describeRequestFailure(e, 'cut');
		return;
	}
	try { layers.value = await fetchLayers(analysisId.value); } catch { layers.value = []; }

	// Mirror the main window from here on. `hello` asks it to send current state, so opening
	// this window after an edit shows the edit rather than the baked recipe.
	sync = openDiagSync(analysisId.value, (msg) => {
		if (msg.t === 'recipe') recipe.value = msg.recipe as Recipe;
		else if (msg.t === 'layers') layers.value = msg.layers as DiagLayer[];
		else if (msg.t === 'isolate') {
			selection.value = msg.clusterId == null
				? null
				: { kind: 'cluster', id: msg.clusterId };
		}
	});
	sync.post({ t: 'hello' });
});

onBeforeUnmount(() => { sync?.close(); sync = null; });
</script>

<template>
	<div class="dpw">
		<header class="dpw-bar">
			<span class="dpw-kicker">Diagnostics · detached view</span>
			<span class="dpw-note">mirrors the main window — edit the recipe there</span>
		</header>
		<div class="dpw-body">
			<p v-if="err" class="dpw-err">{{ err }}</p>
			<SpatialPanel
				v-else-if="ready"
				:analysis-id="analysisId"
				:octree-path="`${diagPath}/full`"
				:recipe="recipe"
				:recipe-valid="true"
				:channel-options="channelOptions"
				:layers="layers"
				:active-layer-name="null"
				:selection="selection"
				:drawing="false"
				:initial-channel="channel"
				no-popout
				@update:channel="(c) => channel = c"
			/>
			<p v-else class="dpw-loading">loading…</p>
		</div>
	</div>
</template>

<style scoped>
.dpw { display: flex; flex-direction: column; height: 100vh; background: var(--bg, #0b1020); }
.dpw-bar { display: flex; align-items: baseline; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.dpw-kicker { font-size: var(--fs-md); font-weight: 700; }
.dpw-note { font-size: var(--fs-xs); color: var(--text-dim); }
.dpw-body { flex: 1; min-height: 0; padding: 10px 12px; }
.dpw-err, .dpw-loading { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); font-size: var(--fs-md); }
.dpw-err { color: var(--danger, #fca5a5); }
</style>
