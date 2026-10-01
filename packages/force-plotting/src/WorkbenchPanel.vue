<script setup lang="ts">
// Shared dockable-panel chrome for the Diagnostics Workbench. Deliberately the same shape as
// apps/force-app/web/src/record/panels/PanelFrame.vue -- that component is app-local and
// force-plotting cannot import across the app/package boundary, so this is a copy, not a
// wrapper. Keep the two in sync by eye if one changes; they are small on purpose.
defineProps<{ title: string; icon?: string; closable?: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
	<div class="wb-panel">
		<div class="wb-panel-handle">
			<span v-if="icon" class="material-symbols-rounded">{{ icon }}</span>
			<span class="wb-panel-title">{{ title }}</span>
			<slot name="title-extra" />
			<span class="wb-panel-grip material-symbols-rounded">drag_indicator</span>
			<button v-if="closable" class="wb-panel-close" title="Close panel" @pointerdown.stop @click.stop="$emit('close')">
				<span class="material-symbols-rounded">close</span>
			</button>
		</div>
		<div class="wb-panel-body"><slot /></div>
		<div v-if="$slots.footer" class="wb-panel-footer"><slot name="footer" /></div>
	</div>
</template>

<style scoped>
.wb-panel { display: flex; flex-direction: column; height: 100%; background: color-mix(in srgb, var(--bg-2) 62%, transparent); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.wb-panel-handle { display: flex; align-items: center; gap: 7px; padding: 8px 12px; cursor: move; background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--border); user-select: none; }
.wb-panel-handle .material-symbols-rounded { font-size: var(--icon-md, 18px); color: var(--text-dim); }
.wb-panel-title { font-size: var(--fs-md, 13px); font-weight: 640; letter-spacing: 0.01em; }
.wb-panel-grip { margin-left: auto; opacity: 0.5; }
.wb-panel-close { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: none; background: transparent; color: var(--text-dim); cursor: pointer; border-radius: 5px; }
.wb-panel-close:hover { color: var(--danger); background: rgba(239,68,68,0.12); }
.wb-panel-close .material-symbols-rounded { font-size: var(--icon-sm, 16px); }
.wb-panel-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 12px; }
.wb-panel-footer { flex-shrink: 0; padding: 10px 12px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--bg-2) 80%, transparent); }
</style>
