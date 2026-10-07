<script setup lang="ts">
/*
 * The pin and hover rings that link a map point to a chart moment, drawn over a map canvas. One
 * component for FrmCloud and FrmOctree so a marker looks the same in Lite and Full. Positions are
 * CSS px in the canvas box (null hides a ring); the host places them. HTML rather than GL so a
 * hover moving over the charts only touches these two props: no render, no rebuild.
 */
defineProps<{
	pin: { x: number; y: number } | null;
	hover: { x: number; y: number } | null;
}>();
</script>

<template>
	<div v-if="pin" class="fc-ring pin" :style="{ left: pin.x + 'px', top: pin.y + 'px' }"></div>
	<div v-if="hover" class="fc-ring hover" :style="{ left: hover.x + 'px', top: hover.y + 'px' }"></div>
</template>

<style scoped>
.fc-ring { position: absolute; border-radius: 50%; box-sizing: border-box; pointer-events: none; transform: translate(-50%, -50%); }
.fc-ring.pin { width: 12px; height: 12px; background: var(--accent, #38bdf8); border: 2px solid var(--text, #fff); box-shadow: 0 0 0 1px rgba(0,0,0,0.5); }
.fc-ring.hover { width: 10px; height: 10px; border: 1.5px solid var(--accent, #38bdf8); opacity: 0.8; box-shadow: 0 0 0 1px rgba(0,0,0,0.4); }
</style>
