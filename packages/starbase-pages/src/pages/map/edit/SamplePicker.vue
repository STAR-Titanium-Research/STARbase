<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { IndexPage, indexDefBySlug, type PickedRow } from '@d1/ui';

// The sample picker (spec E7): the Samples list, with its search, filters, saved views and sorting, opened over the canvas in picker
// mode. Ticked rows come back with the rectangle each had on screen (the fly-in starts from it). Samples already on the canvas are
// drawn but cannot be ticked. Esc, the close button and a click outside close it without adding anything.
defineProps<{
	/** The record ids of the samples already on the canvas. */
	taken: string[];
}>();
const emit = defineEmits<{ pick: [rows: PickedRow[]]; close: [] }>();

const def = computed(() => indexDefBySlug('samples'));
const dialog = ref<HTMLElement | null>(null);
const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
onMounted(async () => {
	await nextTick();
	dialog.value?.focus();
});
onBeforeUnmount(() => {
	if (opener?.isConnected) opener.focus();
});

function onKey(e: KeyboardEvent) {
	if (e.key !== 'Escape') return;
	// A field or a menu inside the list takes its own Escape first (it closes itself and the event is stopped there).
	e.stopPropagation();
	emit('close');
}
</script>

<template>
	<div class="pm-picker-back" @pointerdown.self="emit('close')">
		<div ref="dialog" class="d1-kit d1-process-map pm-picker" role="dialog" aria-modal="true" aria-label="Pick samples" tabindex="-1" @keydown="onKey">
			<div class="bar">
				<h2>Pick samples</h2>
				<span class="hint">Tick the samples to put on the canvas.</span>
				<button type="button" class="x" aria-label="Close" @click="emit('close')"><v-icon name="close" small /></button>
			</div>
			<div class="body">
				<IndexPage v-if="def" :def="def" pick :pick-taken="taken" @pick="(rows: PickedRow[]) => emit('pick', rows)" />
				<p v-else class="none">The Samples list is not available.</p>
			</div>
		</div>
	</div>
</template>

<style scoped>
.pm-picker-back { position: fixed; inset: 0; z-index: 55; display: grid; place-items: center; background: color-mix(in srgb, var(--theme--background) 55%, transparent); backdrop-filter: blur(1px); }
.pm-picker {
	display: flex;
	flex-direction: column;
	width: min(1100px, 94vw);
	height: min(760px, 88vh);
	height: min(760px, 88dvh);
	overflow: hidden;
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 14px;
	box-shadow: var(--d1-shadow-lg, 0 18px 50px rgb(0 0 0 / 0.3));
}
.pm-picker:focus { outline: none; }
.bar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--d1-tile, var(--theme--background-subdued)); border-bottom: 1px solid var(--d1-line); }
.bar h2 { margin: 0; font-size: var(--fs-lg, 15px); }
.hint { flex: 1; color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
.x { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: none; color: inherit; cursor: pointer; }
.x:hover, .x:focus-visible { background: var(--d1-surface); outline: none; }
.body { flex: 1; min-height: 0; overflow: auto; padding: 8px 14px 14px; }
.none { color: var(--d1-dim); }
</style>
