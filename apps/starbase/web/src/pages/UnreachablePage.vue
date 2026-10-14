<script setup lang="ts">
import { onMounted } from 'vue';
import BrandLogo from '../BrandLogo.vue';
import { getConfig } from '../config';

// d1-server did not answer (spec §4): a full page with a way forward, never an endless spinner.
defineProps<{ retrying?: boolean }>();
defineEmits<{ (e: 'retry'): void }>();
const server = getConfig().directusUrl;
// The previous page's title must not linger on this one.
onMounted(() => {
	document.title = "STARbase — can't reach the database";
});
</script>

<template>
	<main class="sb-center">
		<div class="sb-card" role="alert">
			<BrandLogo />
			<h1>Can't reach the database</h1>
			<p>STARbase couldn't reach d1-server at <code>{{ server }}</code>. Check that this device is on the tailnet, then try again.</p>
			<button type="button" class="sb-primary" :disabled="retrying" :aria-busy="retrying ? 'true' : undefined" @click="$emit('retry')"><span v-if="retrying" class="sb-spin" aria-hidden="true" />{{ retrying ? 'Trying…' : 'Try again' }}</button>
		</div>
	</main>
</template>
