<script setup lang="ts">
import { computed } from 'vue';
import { AppLink, CampaignCard, IndexPage, campaignCardStats, indexDefBySlug, thumbKind } from '@d1/ui';
import type { CampaignStats } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import IndexThumb from './index/IndexThumb.vue';

// The :slug route: one generic list page for every collection of INDEX_DEFS. The slug picks the
// definition; an unknown one (a mistyped link, a page that was never made) says so and goes Home.
// The campaigns list has a designed card (the same one the Project page uses): it is filled into the
// page's `card` slot, with the counts loaded for the campaigns on screen, raised like the Projects
// index's cards.
const props = defineProps<{ slug: string }>();
const def = computed(() => indexDefBySlug(props.slug));
const isCampaigns = computed(() => def.value?.collection === 'campaigns');
// Samples, equipment, tools, insert types, manufacturers and operations have a picture per row (in a
// roomy row and on a card): the `thumb` slot is only filled for those, so other lists draw none.
const hasThumb = computed(() => !!def.value && thumbKind(def.value.collection) !== null);
</script>

<template>
	<ExplorerView :title="def?.title ?? 'No such page'">
		<!-- Keyed on the slug: moving from one collection to another starts a fresh page. -->
		<IndexPage v-if="def" :key="def.slug" :def="def" :card-data="isCampaigns ? campaignCardStats : undefined">
			<template v-if="isCampaigns" #card="{ row, data, loading }">
				<CampaignCard :campaign="row" :stats="(data as CampaignStats | null)" :loading="loading" raised />
			</template>
			<template v-if="hasThumb" #thumb="{ row, plots }">
				<IndexThumb :def="def" :row="row" :plots="plots" />
			</template>
		</IndexPage>
		<div v-else class="missing">
			<h2>No such page</h2>
			<p>There is no page called "{{ slug }}".</p>
			<AppLink to="/home">Back to Home</AppLink>
		</div>
	</ExplorerView>
</template>

<style scoped>
.missing { max-width: 520px; margin: 64px auto; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: var(--fs-xl, 18px); }
p { margin: 0 0 8px; color: var(--theme--foreground-subdued); }
</style>
