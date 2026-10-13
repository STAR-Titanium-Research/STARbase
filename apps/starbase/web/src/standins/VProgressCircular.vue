<script setup lang="ts">
// Stand-in for <v-progress-circular indeterminate />: a CSS ring (the `spin` keyframes are in styles.css).
const props = defineProps<{ indeterminate?: boolean; xSmall?: boolean; small?: boolean; large?: boolean }>();
const dim = props.xSmall ? 14 : props.small ? 18 : props.large ? 40 : 28;
</script>

<template>
	<span class="v-progress-circular" :style="{ width: dim + 'px', height: dim + 'px' }" role="progressbar" aria-label="Loading"></span>
</template>

<style scoped>
.v-progress-circular {
	display: inline-block; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent;
	opacity: 0.8; animation: spin 0.9s linear infinite;
}
</style>
