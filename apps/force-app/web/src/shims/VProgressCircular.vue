<script setup lang="ts">
// Stand-in for Directus's global <v-progress-circular indeterminate small />, drawn as the app's
// loading orb. The `indeterminate` prop is accepted for API parity. Inside Directus itself the
// plotting package still gets Directus's own spinner.
import { ThinkingOrb } from '@d1/force-plotting';

const props = defineProps<{
	small?: boolean;
	xSmall?: boolean;
	large?: boolean;
	indeterminate?: boolean;
}>();

const dim = props.xSmall ? 14 : props.small ? 18 : props.large ? 40 : 28;
</script>

<template>
	<ThinkingOrb :size="dim" />
</template>
