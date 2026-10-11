<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { EXPLORER_HOST, ExplorerNav, Finder, isFinderShortcut, isModalOpen } from '@d1/ui';
import { useExplorerHost } from './explorerHost';

// The frame of every Explorer page in the Directus app: Directus's <private-view> with the
// Explorer sidebar in its navigation column, and the ExplorerHost provided to everything inside.
// A page uses it exactly where it used <private-view>: same title, same slots (headline,
// title-outer:prepend, actions, ...), which are passed straight through.
defineProps<{ title: string }>();

provide(EXPLORER_HOST, useExplorerHost());

// The finder dialog: opened by the sidebar's box and by Ctrl K / Cmd K anywhere in the app.
const finderOpen = ref(false);
const openFinder = () => {
	finderOpen.value = true;
};

// A Directus drawer or dialog being open means the user is in the middle of a form: Ctrl K does
// not pull the finder over it. (See isModalOpen for why this is not `.v-overlay.active`.)
const overlayOpen = () => isModalOpen(document);

function onKeydown(e: KeyboardEvent) {
	if (!isFinderShortcut(e)) return;
	// The browser's own Ctrl K (focus the search bar) must not fire, in an input or not.
	e.preventDefault();
	if (finderOpen.value || overlayOpen()) return;
	openFinder();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
	<private-view :title="title">
		<template #navigation>
			<ExplorerNav :show-brand="false" @open-finder="openFinder" />
			<Finder v-if="finderOpen" @close="finderOpen = false" />
		</template>
		<template v-for="(_, name) in $slots" :key="name" #[name]="slotProps">
			<slot :name="name" v-bind="slotProps || {}" />
		</template>
	</private-view>
</template>
