<script setup lang="ts">
/*
 * The campaign form's "overview and operations" panel: counts and progress, the sample, operation
 * and test lists, and the pickers to add samples, test sessions and operations. The operations
 * search is pre-filtered by the campaign's type (a Machining trial only surfaces machining
 * operations). It is a thin wrapper: the panel is the kit's CampaignWorkbench, the same one the
 * Campaign page shows (with the matrix, which is too wide for the form).
 * Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md, "Campaign".
 */
import { computed, inject, ref } from 'vue';
import { CampaignWorkbench } from '@d1/ui';

const props = defineProps<{ primaryKey?: string | number | null }>();

// The live form values, so the operations search follows the campaign_type dropdown without a save.
const values = inject<any>('values', ref({}));
const campaignType = computed(() => values.value?.campaign_type as string | undefined);
const isNew = computed(() => props.primaryKey == null || props.primaryKey === '+');
</script>

<template>
	<div class="co">
		<p v-if="isNew" class="msg">Save the campaign first, then add samples, operations and tests here.</p>
		<CampaignWorkbench v-else :campaign-id="String(primaryKey)" :campaign-type="campaignType" :show-matrix="false" />
	</div>
</template>

<style scoped>
.co { font-size: 13px; }
.msg { margin: 0; padding: 8px 2px; color: var(--theme--foreground-subdued); }
</style>
