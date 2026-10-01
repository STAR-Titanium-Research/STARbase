<script setup lang="ts">
/*
 * Paint-layer list for the Diagnostics Workbench Spatial panel. Presentational only: it emits
 * intent (add / rename / delete / set-active / toggle-drawing) and the workbench owns the
 * Directus CRUD and the preview round-trip. The row marked active is also the mask that binds
 * to compute — only one mask applies at a time (see DiagnosticsWorkbench.recipeForPreview).
 */
import { ref } from 'vue';
import type { DiagLayer, LayerRole } from './diagLayers';

defineProps<{ layers: DiagLayer[]; activeName: string | null; drawing: boolean }>();
const emit = defineEmits<{
	(e: 'update:activeName', n: string | null): void;
	(e: 'update:drawing', v: boolean): void;
	(e: 'add', role: LayerRole): void;
	(e: 'rename', p: { layer: DiagLayer; name: string }): void;
	(e: 'delete', layer: DiagLayer): void;
}>();

const ROLE_DOT: Record<LayerRole, string> = { mask: '#f59e0b', label: '#38bdf8', seed: '#a78bfa' };
const editing = ref<string | null>(null);
const draft = ref('');

function startEdit(l: DiagLayer) {
	editing.value = l.layer_id;
	draft.value = l.name;
}
function commitEdit(l: DiagLayer) {
	if (draft.value.trim() && draft.value.trim() !== l.name) {
		emit('rename', { layer: l, name: draft.value.trim() });
	}
	editing.value = null;
}
function ringCount(l: DiagLayer) {
	return l.geometry?.polygons?.length ?? 0;
}
</script>

<template>
	<div class="layer-panel">
		<div class="lp-tools">
			<button :class="{ on: drawing }" @click="emit('update:drawing', !drawing)">
				{{ drawing ? '■ stop drawing' : '✎ draw polygon' }}
			</button>
			<span class="lp-add">
				<button @click="emit('add', 'mask')">+ mask</button>
				<button @click="emit('add', 'label')">+ label</button>
				<button @click="emit('add', 'seed')">+ seed</button>
			</span>
		</div>
		<ul class="lp-list">
			<li
				v-for="l in layers"
				:key="l.layer_id"
				:class="{ active: l.name === activeName }"
				@click="emit('update:activeName', l.name === activeName ? null : l.name)"
			>
				<span class="lp-dot" :style="{ background: ROLE_DOT[l.role] }" />
				<input
					v-if="editing === l.layer_id"
					v-model="draft"
					@click.stop
					@keyup.enter="commitEdit(l)"
					@blur="commitEdit(l)"
				/>
				<span v-else class="lp-name" @dblclick.stop="startEdit(l)">{{ l.name }}</span>
				<span class="lp-meta">{{ l.role }} · {{ ringCount(l) }} ring{{ ringCount(l) === 1 ? '' : 's' }}</span>
				<button class="lp-del" title="delete" @click.stop="emit('delete', l)">✕</button>
			</li>
			<li v-if="!layers.length" class="lp-empty">no layers — paint one to mask an artefact</li>
		</ul>
	</div>
</template>

<style scoped>
.layer-panel { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm, 12px); }
.lp-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.lp-tools button { font-size: var(--fs-xs, 11px); padding: 3px 7px; border-radius: 6px; border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); background: var(--bg-2, #111a33); color: var(--text, #e5e7eb); cursor: pointer; }
.lp-tools button.on { background: #d97706; border-color: #f59e0b; color: #fff; }
.lp-add { display: inline-flex; gap: 4px; }
.lp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.lp-list li { display: flex; align-items: center; gap: 6px; padding: 3px 5px; border-radius: 5px; cursor: pointer; }
.lp-list li.active { background: color-mix(in srgb, #f59e0b 16%, transparent); }
.lp-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.lp-name { flex: 1; }
.lp-meta { color: var(--text-dim, #94a3b8); font-size: var(--fs-xs, 11px); }
.lp-del { border: none; background: none; color: var(--text-dim, #94a3b8); cursor: pointer; }
.lp-empty { color: var(--text-dim, #94a3b8); font-style: italic; padding: 4px; }
.lp-list input { flex: 1; font-size: var(--fs-sm, 12px); background: var(--bg-1, #0b1020); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; }
</style>
