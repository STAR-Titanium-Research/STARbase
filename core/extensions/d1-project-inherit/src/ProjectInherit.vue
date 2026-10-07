<template>
	<div class="d1-project-inherit">
		<v-select
			:items="items"
			:model-value="value"
			placeholder="Select a project…"
			show-deselect
			:search="true"
			@update:model-value="emit('input', $event)"
		/>
		<small v-if="inherited" class="hint">Inherited from campaign — override by selecting another</small>
	</div>
</template>

<script setup lang="ts">
import { inject, ref, computed, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';

const props = defineProps<{ value: string | null; primaryKey?: string | number | null }>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

const values = inject<Ref<Record<string, any>>>('values', ref({}));
const api = useApi();

const items = ref<{ text: string; value: string }[]>([]);
const inherited = ref(false);

// Load all projects once for the dropdown.
api.get('/items/projects', {
	params: { fields: ['project_id', 'project_code', 'project_name'], sort: 'project_code', limit: -1 },
}).then((res: any) => {
	items.value = (res?.data?.data ?? []).map((p: any) => ({
		text: `${p.project_code ?? ''} – ${p.project_name ?? ''}`.trim(),
		value: p.project_id,
	}));
}).catch(() => {});

const campaignId = computed<string | null>(() => values.value?.campaign_id ?? null);

// When the campaign changes and no project is set yet, inherit the campaign's project. Never touches
// a saved record just because it was opened (its stored value may not have reached `value` yet):
// an existing record inherits only after the user changes the campaign, and only into a blank field.
const isExisting = () => props.primaryKey != null && props.primaryKey !== '+';
let openedWithCampaign: string | null | undefined;
let req = 0;
watch(campaignId, async (id) => {
	const mine = ++req;
	if (openedWithCampaign === undefined) openedWithCampaign = id;
	if (!id) {
		inherited.value = false;
		return;
	}
	if (isExisting() && id === openedWithCampaign) return; // just opened: leave the stored value alone
	if (props.value) return; // explicit choice wins
	try {
		const res = await api.get(`/items/campaigns/${id}`, { params: { fields: ['project_id'] } });
		if (mine !== req) return; // the campaign changed again meanwhile
		const proj: string | null = res?.data?.data?.project_id ?? null;
		if (proj && !props.value) {
			inherited.value = true;
			emit('input', proj);
		}
	} catch {
		// Inheritance is a convenience: on failure the field stays as it is and can be set by hand.
	}
}, { immediate: true });
</script>

<style scoped>
.d1-project-inherit { width: 100%; }
.hint {
	display: block;
	margin-top: 4px;
	font-size: 12px;
	color: var(--theme--foreground-subdued, #999);
	font-style: italic;
}
</style>
