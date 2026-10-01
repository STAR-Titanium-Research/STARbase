<script setup lang="ts">
// A titled panel shell for the modular recording workspace. The header doubles as the grid
// drag handle (class `panel-handle`, referenced by GridItem's drag-allow-from). Emits `close`
// when the ✕ is clicked so the workspace can remove this panel instance. A #title slot replaces
// the plain title (the plot panels put their mode picker there); buttons in it don't start a drag,
// since grid-layout-plus ignores drags that begin on a button.
// `dense` thins the body's top/bottom padding, for a one-line strip like the Overview.
defineProps<{ title: string; icon?: string; closable?: boolean; dense?: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
	<div class="panel-frame">
		<div class="panel-handle">
			<span v-if="icon" class="material-symbols-rounded">{{ icon }}</span>
			<!-- flex:1, so a picker in the slot has the header's free width to slide open into. -->
			<div class="panel-title-slot"><slot name="title"><span class="panel-title">{{ title }}</span></slot></div>
			<span class="panel-grip material-symbols-rounded">drag_indicator</span>
			<button v-if="closable" class="panel-close" title="Close panel" @pointerdown.stop @click.stop="$emit('close')">
				<span class="material-symbols-rounded">close</span>
			</button>
		</div>
		<div class="panel-body" :class="{ dense }"><slot /></div>
		<!-- Rendered as a flex-shrink:0 sibling AFTER panel-body (which is flex:1 and always fills the
			 remaining height), not inside its scroll region — so footer content (e.g. transport/start-
			 stop controls) stays pinned to the panel's bottom edge and visible without scrolling, like a
			 frozen row, instead of trailing the scrollable content wherever it happens to end. -->
		<div v-if="$slots.footer" class="panel-footer"><slot name="footer" /></div>
	</div>
</template>

<style scoped>
/* DESIGN TEST: was color-mix(--bg-2 62%, transparent) -- a translucent wash that left every panel
   within a few percent of the ground, so nine panels read as one undifferentiated dark field.
   Opaque surface + a header that is a shade lighter again, so a panel reads as a stacked thing
   with a lid rather than an outlined region of the background. */
.panel-frame { display: flex; flex-direction: column; height: 100%; background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18); }
.panel-handle { display: flex; align-items: center; gap: 7px; padding: 8px 12px; cursor: move; background: var(--surface); border-bottom: 1px solid var(--border); user-select: none; }
.panel-handle .material-symbols-rounded { font-size: var(--icon-md); color: var(--text-dim); }
.panel-title-slot { flex: 1; min-width: 0; display: flex; align-items: center; font-size: var(--fs-md); font-weight: 640; letter-spacing: 0.01em; }
.panel-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-grip { opacity: 0.5; }
.panel-close { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: none; background: transparent; color: var(--text-dim); cursor: pointer; border-radius: 5px; }
.panel-close:hover { color: var(--danger); background: rgba(239,68,68,0.12); }
.panel-close .material-symbols-rounded { font-size: var(--icon-sm); }
/* container-type:size makes this box a @container reference for its content — panels whose
	   content wants to compress as the grid resizes (rather than just scroll) query against
	   container name "panel-body" (see RecordingOptions.vue). Safe for every other panel here:
	   they already size their own content to fill available space (flex:1/min-height:0,
	   absolutely-positioned children) instead of growing this box to fit, so contain:size
	   (implied by container-type:size) changes nothing for them. */
	.panel-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 12px; container-type: size; container-name: panel-body; }
.panel-body.dense { padding-block: 4px; }
.panel-footer { flex-shrink: 0; padding: 10px 12px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--bg-2) 80%, transparent); }
</style>
