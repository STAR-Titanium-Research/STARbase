<script setup lang="ts">
/*
 * The series picker of a plot tile (right-click, or the tile's pick button): the trace's series grouped by
 * quantity, with a search, a checkbox each. Closing is the parent's: a click outside or Escape.
 */
import { computed, onMounted, ref } from 'vue';
import type { SeriesMeta } from './fastCache';
import { groupTitle } from './fastTiles';
import { unitLabel } from './chartMath';

const props = defineProps<{ catalog: SeriesMeta[]; selected: string[]; x: number; y: number }>();
const emit = defineEmits<{ (e: 'toggle', key: string): void; (e: 'close'): void }>();

const query = ref('');
const input = ref<HTMLInputElement | null>(null);
onMounted(() => input.value?.focus());

const groups = computed(() => {
	const q = query.value.trim().toLowerCase();
	const by: Record<string, SeriesMeta[]> = {};
	for (const s of props.catalog) {
		if (q && !`${s.label} ${s.unit} ${groupTitle(s.group)}`.toLowerCase().includes(q)) continue;
		(by[s.group] ||= []).push(s);
	}
	return Object.entries(by).sort((a, b) => groupTitle(a[0]).localeCompare(groupTitle(b[0])));
});
</script>

<template>
	<div class="ctx" role="dialog" aria-label="Pick series" :style="{ left: x + 'px', top: y + 'px' }" @click.stop @pointerdown.stop @keydown.esc.stop="emit('close')">
		<div class="ctx-search"><v-icon name="search" x-small /><input ref="input" v-model="query" placeholder="Search series" aria-label="Search series" /></div>
		<div class="ctx-body">
			<div v-for="[grp, items] in groups" :key="grp" class="ctx-group">
				<div class="ctx-label">{{ groupTitle(grp) }}</div>
				<label v-for="s in items" :key="s.key" class="ctx-item">
					<input type="checkbox" :checked="selected.includes(s.key)" @change="emit('toggle', s.key)" />
					<span>{{ s.label }}</span><em>{{ unitLabel(s.unit) }}</em>
				</label>
			</div>
			<div v-if="!groups.length" class="empty">No series match</div>
		</div>
	</div>
</template>

<style scoped>
.ctx { position: fixed; z-index: 50; width: 260px; max-height: min(60vh, 420px); display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
	background: var(--fd-surface); border: 1px solid var(--theme--border-color); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); font-size: var(--fs-sm, 12px); }
.ctx-search { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--fd-line); color: var(--fd-dim); }
.ctx-search input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; font: inherit; color: var(--theme--foreground); }
.ctx-body { overflow-y: auto; padding: 2px 0 6px; }
.ctx-label { padding: 8px 12px 2px; font-size: var(--fs-xs, 11px); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fd-dim); }
.ctx-item { display: flex; align-items: center; gap: 8px; padding: 3px 12px; cursor: pointer; }
.ctx-item:hover { background: var(--fd-tile); }
.ctx-item em { margin-left: auto; font-style: normal; font-size: var(--fs-xs, 11px); color: var(--fd-dim); }
.empty { padding: 12px; text-align: center; color: var(--fd-dim); }
</style>
