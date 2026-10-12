<script setup lang="ts">
import { ref, watch } from 'vue';
import { contactLine } from '@d1/ui';
import type { useLabelSettings } from './useLabelSettings';
import './form.css';

// "Contact on labels: <email>" (or "No lab contact set"), under the template picker. Everyone sees it; an admin
// also gets an input and Save, which is one PATCH of the label_settings singleton. The email is printed into
// every label's QR code, so that someone who finds a sample can reach the lab.
const props = defineProps<{ settings: ReturnType<typeof useLabelSettings>; isAdmin: boolean }>();

const text = ref(props.settings.contactEmail.value ?? '');
const editing = ref(false);
// Follow a load or a save, but never overwrite what an admin is typing.
watch(() => props.settings.contactEmail.value, (v) => {
	if (!editing.value) text.value = v ?? '';
});
async function save(): Promise<void> {
	if (await props.settings.save(text.value)) editing.value = false;
}
</script>

<template>
	<div class="contact">
		<p class="d1-note" role="status">{{ settings.loaded.value ? contactLine(settings.contactEmail.value) : 'Loading the lab contact…' }}</p>
		<p v-if="settings.loadError.value" class="d1-note warn" role="alert">{{ settings.loadError.value }}</p>
		<form v-if="isAdmin && settings.loaded.value" class="lf-row edit" aria-label="Lab contact" @submit.prevent="save">
			<label class="lf-field grow">Contact email (admins)
				<input v-model="text" type="text" inputmode="email" placeholder="lab@example.org" autocomplete="off" @input="editing = true" />
			</label>
			<button type="submit" class="lf-btn" :disabled="settings.saving.value || text.trim() === (settings.contactEmail.value ?? '')">Save</button>
		</form>
		<p v-if="settings.saveError.value" class="d1-note bad" role="alert">{{ settings.saveError.value }}</p>
	</div>
</template>

<style scoped>
.contact { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.edit { align-items: flex-end; }
.grow { flex: 1 1 220px; }
</style>
