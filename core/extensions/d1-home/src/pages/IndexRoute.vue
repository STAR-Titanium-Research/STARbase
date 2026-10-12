<script setup lang="ts">
import { computed } from 'vue';
import { IndexPage, indexDefBySlug } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';

// The :slug route: one generic list page for every collection of INDEX_DEFS. The slug picks the
// definition; an unknown one (a mistyped link, a page that was never made) says so and goes Home.
const props = defineProps<{ slug: string }>();
const def = computed(() => indexDefBySlug(props.slug));
</script>

<template>
	<ExplorerView :title="def?.title ?? 'No such page'">
		<!-- Keyed on the slug: moving from one collection to another starts a fresh page. -->
		<IndexPage v-if="def" :key="def.slug" :def="def" />
		<div v-else class="missing">
			<h2>No such page</h2>
			<p>There is no page called "{{ slug }}".</p>
			<router-link to="/home">Back to Home</router-link>
		</div>
	</ExplorerView>
</template>

<style scoped>
.missing { max-width: 520px; margin: 64px auto; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: var(--fs-xl, 18px); }
p { margin: 0 0 8px; color: var(--theme--foreground-subdued); }
</style>
