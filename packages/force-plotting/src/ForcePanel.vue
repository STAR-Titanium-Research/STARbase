<script setup lang="ts">
/*
 * The frame of a panel in the grid right of the operation column (Signals, FRM, Wear trend, Metadata
 * doctor): a lid with the drag grip, the title (or the `title` slot), the panel's own tools and a close
 * button, then the body. The grip is what grid-layout-plus drags by (`.pg-grip`).
 */
defineProps<{ title?: string; icon?: string; closable?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
	<section class="fp-panel gp">
		<header class="fp-lid gp-lid">
			<span class="pg-grip" title="Drag to move"><v-icon name="drag_indicator" x-small /></span>
			<slot name="title"><v-icon v-if="icon" :name="icon" x-small /><span>{{ title }}</span></slot>
			<slot name="lid" />
			<span class="grow"></span>
			<slot name="tools" />
			<button v-if="closable !== false" class="fp-btn icon" title="Close panel" aria-label="Close panel" @click="emit('close')"><v-icon name="close" x-small /></button>
		</header>
		<slot />
	</section>
</template>

<style scoped>
.gp { height: 100%; }
/* the tools wrap under the title in a narrow panel instead of pushing the close button out */
.gp-lid { flex-wrap: wrap; row-gap: 4px; padding-top: 6px; padding-bottom: 6px; }
.gp-lid .grow { flex: 1 1 8px; }
.pg-grip { display: inline-flex; cursor: move; color: var(--fp-dim); }
.pg-grip:hover { color: var(--theme--foreground); }
</style>
