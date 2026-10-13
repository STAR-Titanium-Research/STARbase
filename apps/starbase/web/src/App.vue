<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useApp } from './context';
import UnreachablePage from './pages/UnreachablePage.vue';
import { shellView } from './shellView';

const { session } = useApp();
const router = useRouter();
const route = useRoute();
const retrying = ref(false);
const view = computed(() => shellView(session.state.value, route.meta.public === true));

// After "Can't reach the database": ask again, then re-run the current navigation so the guard decides
// where it goes (the page, or /signin when the session is gone).
async function retry() {
	retrying.value = true;
	try {
		if ((await session.load()) === 'unreachable') return;
		const here = router.currentRoute.value;
		await router.replace({ path: here.path, query: here.query, hash: here.hash, force: true });
	} finally {
		retrying.value = false;
	}
}
</script>

<template>
	<UnreachablePage v-if="view === 'unreachable'" :retrying="retrying" @retry="retry" />
	<router-view v-else-if="view === 'route'" />
</template>
