<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

// The Blender-style tooltip of a wire or a socket (spec D17): a small dark label that follows the pointer
// inside the canvas and lists what it connects, one line per fact. It takes no pointer itself. `canvas` is
// the element the pointer is tracked in (the position is relative to it); `lines` is null when nothing
// is hovered. Always mounted so it knows where the pointer is when a wire is first entered.
const props = defineProps<{ lines: string[] | null; canvas: HTMLElement | null; hint?: string }>();

const at = ref({ x: 0, y: 0 });
function move(e: MouseEvent): void {
	const r = props.canvas?.getBoundingClientRect();
	if (r) at.value = { x: e.clientX - r.left + 14, y: e.clientY - r.top + 14 };
}
let tracked: HTMLElement | null = null;
const stop = () => void (tracked?.removeEventListener('mousemove', move), (tracked = null));
const track = (el: HTMLElement | null) => {
	stop();
	tracked = el;
	el?.addEventListener('mousemove', move);
};
onMounted(() => track(props.canvas));
watch(() => props.canvas, track);
onBeforeUnmount(stop);
</script>

<template>
	<div class="wire-tip" :class="{ show: !!lines?.length }" :style="{ left: `${at.x}px`, top: `${at.y}px` }" role="tooltip" aria-hidden="true">
		<div v-for="(l, i) in lines ?? []" :key="i">{{ l }}</div>
		<div v-if="hint && lines?.length" class="tk">{{ hint }}</div>
	</div>
</template>

<style scoped>
.wire-tip {
	position: absolute;
	z-index: 30;
	pointer-events: none;
	opacity: 0;
	transition: opacity 0.1s;
	max-width: 280px;
	padding: 6px 10px;
	border-radius: 8px;
	background: var(--theme--foreground);
	color: var(--theme--background);
	font-size: var(--fs-sm, 12px);
	line-height: 1.4;
	box-shadow: var(--d1-shadow-lg, var(--d1-shadow));
}
.wire-tip.show { opacity: 1; }
.tk { margin-top: 4px; opacity: 0.7; font-size: var(--fs-xs, 11px); }
</style>
