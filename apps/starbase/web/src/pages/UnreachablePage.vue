<script setup lang="ts">
import { onMounted } from 'vue';
import BrandLogo from '../BrandLogo.vue';
import { getConfig } from '../config';

// d1-server did not answer (spec §4): a full page with a way forward, never an endless spinner.
const props = defineProps<{ retrying?: boolean; restarting?: boolean }>();
defineEmits<{ (e: 'retry'): void }>();
const server = getConfig().directusUrl;
// The previous page's title must not linger on this one.
onMounted(() => {
	document.title = props.restarting ? 'STARbase — database under maintenance' : "STARbase — can't reach the database";
});
</script>

<template>
	<main class="sb-center">
		<div class="sb-card" role="alert">
			<BrandLogo />
			<h1>{{ restarting ? 'Database under maintenance' : "Can't reach the database" }}</h1>
			<p v-if="restarting">The database is under maintenance, probably restarting. Try again in a moment.</p>
			<p v-else>STARbase couldn't reach d1-server at <code>{{ server }}</code>. Check that Tailscale is connected on this device, then try again.</p>
			<button type="button" class="sb-primary" :disabled="retrying" :aria-busy="retrying ? 'true' : undefined" @click="$emit('retry')"><span v-if="retrying" class="sb-spin" aria-hidden="true" />{{ retrying ? 'Trying…' : 'Try again' }}</button>
		</div>
	</main>
</template>
