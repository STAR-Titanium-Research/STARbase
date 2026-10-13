<script setup lang="ts">
import { computed } from 'vue';
import { Section, useExplorerHost, usePins, type NavPrefs } from '@d1/ui';
import SaveNote from './SaveNote.vue';
import type { Saves } from './useSaves';

// Settings → Sidebar: the two sidebar preferences. STARbase's shell applies them; inside Directus the
// sidebar stays in Directus's navigation column, so both are shown disabled with "Applies in STARbase".
const props = defineProps<{ saves: Saves }>();
const host = useExplorerHost();
const pins = usePins();
const enabled = computed(() => host.appearance === 'own' && pins.loaded.value);

type Key = 'sidebarCollapsed' | 'autoCollapse';
const SWITCHES: Array<{ key: Key; label: string }> = [
	{ key: 'sidebarCollapsed', label: 'Start collapsed' },
	{ key: 'autoCollapse', label: 'Collapse automatically on narrow windows' },
];

function toggle(key: Key, el: HTMLInputElement): void {
	const value = el.checked;
	void props.saves.run(key, async () => {
		await pins.setPref(key, value as NavPrefs[Key]);
		// A failed save was undone in the state; make the box show the stored value even if Vue saw no change.
		el.checked = pins.prefs.value[key];
		return pins.prefs.value[key] === value;
	});
}
</script>

<template>
	<Section title="Sidebar">
		<div class="st-rows">
			<div v-for="s in SWITCHES" :key="s.key" class="st-row">
				<label class="st-check" :class="{ disabled: !enabled }">
					<input
						type="checkbox"
						:checked="pins.prefs.value[s.key]"
						:disabled="!enabled"
						@change="toggle(s.key, $event.target as HTMLInputElement)"
					/>
					{{ s.label }}
				</label>
				<span v-if="host.appearance !== 'own'" class="st-status">Applies in STARbase</span>
				<SaveNote :saves="saves" :save-key="s.key" />
			</div>
		</div>
	</Section>
</template>
