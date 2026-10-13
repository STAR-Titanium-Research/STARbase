<script setup lang="ts">
defineProps<{ indeterminate?: boolean }>();
</script>

<template>
	<div class="v-progress-linear" role="progressbar" aria-label="Loading"><span class="bar" /></div>
</template>

<style scoped>
.v-progress-linear { position: relative; height: 4px; overflow: hidden; border-radius: 2px; background: var(--theme--background-normal); }
.bar { position: absolute; inset: 0 auto 0 0; width: 40%; background: var(--theme--primary); animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { from { left: -40%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; width: 100%; opacity: 0.4; } }
</style>
