<script setup lang="ts">
// "Link to a person…": attach a login that has no person to a person who has no login. An administrator's write (ADR-0011: the link
// decides whose records a person sees); the server still refuses anyone else.
import { computed, ref, watch } from 'vue';
import { errorText, useExplorerHost } from '@d1/ui';
import type { PeopleRow } from './peopleQuery';

const props = defineProps<{ modelValue: boolean; login: PeopleRow | null; rows: PeopleRow[] }>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'linked'): void }>();

const { api } = useExplorerHost();
const personId = ref<string | null>(null);
const saving = ref(false);
const err = ref('');
const close = () => emit('update:modelValue', false);

// People with no login, by name.
const items = computed(() =>
	props.rows
		.filter((r) => r.kind === 'person' && r.person_id && r.login === null && !r.user_id)
		.map((r) => ({ text: r.email ? `${r.full_name} (${r.email})` : r.full_name, value: r.person_id as string })),
);

watch(
	() => props.modelValue,
	(open) => {
		if (!open) return;
		personId.value = null;
		err.value = '';
	},
);

async function save() {
	if (!personId.value || !props.login?.user_id) return;
	saving.value = true;
	err.value = '';
	try {
		await api.patch(`/items/people/${encodeURIComponent(personId.value)}`, { user_id: props.login.user_id });
		close();
		emit('linked');
	} catch (e) {
		err.value = errorText(e, 'Could not link the login.');
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" @esc="close">
		<v-card class="link-card">
			<v-card-title>Link {{ login?.full_name }} to a person</v-card-title>
			<v-card-text>
				<p class="hint">{{ login?.login?.email ?? login?.email }} has a login but is not linked to anyone. Choose the person it belongs to.</p>
				<v-select v-model="personId" :items="items" placeholder="Choose a person with no login" />
				<p v-if="!items.length" class="hint">Everyone already has a login. Add the person first, then link.</p>
				<p v-if="err" class="err">{{ err }}</p>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button secondary @click="close">Cancel</v-button>
				<v-button :loading="saving" :disabled="!personId" @click="save">Link</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.link-card { width: 460px; max-width: 94vw; }
.hint { margin: 0 0 10px; font-size: var(--fs-sm, 12px); color: var(--theme--foreground-subdued, #6b7684); }
.spacer { flex: 1; }
.err { color: var(--theme--danger); font-size: 12px; margin: 8px 0 0; }
</style>
