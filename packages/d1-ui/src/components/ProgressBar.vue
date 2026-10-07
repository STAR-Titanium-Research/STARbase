<script setup lang="ts">
import { computed } from 'vue';

// "n of m" as a bar. `max` of 0 shows an empty bar, not NaN.
const props = defineProps<{ value: number; max: number; label?: string }>();
const pct = computed(() => (props.max > 0 ? Math.min(100, Math.max(0, (props.value / props.max) * 100)) : 0));
</script>

<template>
	<div class="d1-progress">
		<div class="track" role="progressbar" :aria-valuenow="value" :aria-valuemin="0" :aria-valuemax="max">
			<div class="fill" :style="{ width: pct + '%' }" />
		</div>
		<span class="text">{{ label ?? `${value} / ${max}` }}</span>
	</div>
</template>

<style scoped>
.d1-progress { display: flex; align-items: center; gap: 10px; }
.track {
	flex: 1;
	height: 8px;
	border-radius: 99px;
	background: var(--theme--background-normal);
	overflow: hidden;
}
.fill { height: 100%; border-radius: 99px; background: var(--theme--primary); transition: width 0.25s ease; }
.text { font-size: 12px; color: var(--theme--foreground-subdued); white-space: nowrap; }
</style>
