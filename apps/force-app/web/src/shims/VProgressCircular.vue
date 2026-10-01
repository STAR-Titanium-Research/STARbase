<script setup lang="ts">
// Minimal stand-in for Directus's global <v-progress-circular indeterminate small />.
// A pure-CSS indeterminate ring; the `indeterminate` prop is accepted for API parity.
const props = defineProps<{
	small?: boolean;
	xSmall?: boolean;
	large?: boolean;
	indeterminate?: boolean;
}>();

const dim = props.xSmall ? 14 : props.small ? 18 : props.large ? 40 : 28;
</script>

<template>
	<span
		class="v-progress-circular-shim"
		:style="{ width: dim + 'px', height: dim + 'px' }"
		role="progressbar"
		aria-label="loading"
	></span>
</template>

<style scoped>
.v-progress-circular-shim {
	display: inline-block;
	border-radius: 50%;
	border: 2px solid currentColor;
	border-top-color: transparent;
	opacity: 0.8;
	animation: spin 0.9s linear infinite; /* global keyframes (styles.css) */
}
</style>
