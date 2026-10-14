<script setup lang="ts">
import type { ToolingFocus, ToolingModel } from '@d1/ui';

// PLACEHOLDER until stream S2 lands the real stage (3D view and 2D fallback). The contract is fixed:
// the model, the focus and the next fresh edge in; a `select` with the new focus out. The page turns
// `select` into a route, so this only lists the inserts and edges as buttons.
defineProps<{ model: ToolingModel; focus: ToolingFocus; nextFresh: { insertId: string; edgeId: string } | null }>();
defineEmits<{ select: [focus: ToolingFocus] }>();
</script>

<template>
	<div class="stage">
		<button type="button" @click="$emit('select', { kind: 'box' })">Box {{ model.boxCode }}</button>
		<div v-for="i in model.inserts" :key="i.id" class="row">
			<button type="button" :class="{ on: focus.kind !== 'box' && focus.insertId === i.id }" @click="$emit('select', { kind: 'insert', insertId: i.id })">
				Insert {{ i.number ?? i.code }} ({{ i.state }})
			</button>
			<button
				v-for="e in i.edges"
				:key="e.id"
				type="button"
				:class="{ on: focus.kind === 'edge' && focus.edgeId === e.id, next: nextFresh?.edgeId === e.id }"
				@click="$emit('select', { kind: 'edge', insertId: i.id, edgeId: e.id })"
			>
				{{ e.letter ?? e.identifier }}
			</button>
		</div>
	</div>
</template>

<style scoped>
.stage { display: flex; flex-direction: column; gap: 6px; min-height: 120px; padding: 12px; background: var(--d1-tile, var(--theme--background-subdued)); border: 1px solid var(--d1-line, var(--theme--border-color-subdued)); border-radius: var(--d1-radius, 12px); }
.row { display: flex; flex-wrap: wrap; gap: 6px; }
button { padding: 2px 8px; border: 1px solid var(--d1-line, var(--theme--border-color-subdued)); border-radius: 6px; background: var(--d1-surface, var(--theme--background)); color: var(--theme--foreground); font: inherit; cursor: pointer; }
button.on { border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-accent, var(--theme--primary)); }
button.next { border-style: dashed; }
</style>
