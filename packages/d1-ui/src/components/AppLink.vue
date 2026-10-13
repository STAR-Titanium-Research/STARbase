<script setup lang="ts">
import { computed } from 'vue';
import { resolveLink } from '../links';

// A link written as a Directus app path (see links.ts): a router-link when it is a route of this
// host, a new-tab <a> when it is not. Attributes (class, title, @click.stop) fall through to either.
const props = defineProps<{ to: string }>();
const link = computed(() => resolveLink(props.to));
</script>

<template>
	<router-link v-if="link.kind === 'route'" :to="link.to"><slot /></router-link>
	<a v-else :href="link.href" target="_blank" rel="noopener"><slot /></a>
</template>
