<script setup lang="ts">
import { computed } from 'vue';
import { AppLink, Section, useExplorerHost, usePins, type NavPrefs } from '@d1/ui';
import SaveNote from './SaveNote.vue';
import type { Saves } from './useSaves';

// Settings → Appearance. Where the host draws its own theme (STARbase) the choice is System, Light or
// Dark, saved as the `theme` preference, which the shell applies. Inside Directus the theme belongs to the
// Directus account, so the section says so and links there.
const props = defineProps<{ saves: Saves }>();
const host = useExplorerHost();
const pins = usePins();
const own = computed(() => host.appearance === 'own');

const THEMES: Array<{ value: NavPrefs['theme']; label: string }> = [
	{ value: 'system', label: 'System' },
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' },
];

function choose(theme: NavPrefs['theme'], group: HTMLElement | null): void {
	void props.saves.run('theme', async () => {
		await pins.setPref('theme', theme);
		// A failed save was undone in the state; make the radios show the stored value even if Vue saw no change.
		group?.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((r) => {
			r.checked = r.value === pins.prefs.value.theme;
		});
		return pins.prefs.value.theme === theme;
	});
}
</script>

<template>
	<Section title="Appearance">
		<fieldset v-if="own" class="st-radios">
			<legend>Theme</legend>
			<label v-for="t in THEMES" :key="t.value" class="st-check">
				<input type="radio" name="theme" :value="t.value" :checked="pins.prefs.value.theme === t.value" :disabled="!pins.loaded.value" @change="choose(t.value, ($event.target as HTMLElement).closest('fieldset'))" />
				{{ t.label }}
			</label>
			<SaveNote :saves="saves" save-key="theme" />
		</fieldset>
		<p v-else class="st-title">
			Theme is set in your Directus account.
			<AppLink to="/users/me">Open your account</AppLink>
		</p>
	</Section>
</template>
