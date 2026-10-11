<script setup lang="ts">
import { provide } from 'vue';
import { EXPLORER_HOST, ExplorerNav } from '@d1/ui';
import { useExplorerHost } from './explorerHost';

// The frame of every Explorer page in the Directus app: Directus's <private-view> with the
// Explorer sidebar in its navigation column, and the ExplorerHost provided to everything inside.
// A page uses it exactly where it used <private-view>: same title, same slots (headline,
// title-outer:prepend, actions, ...), which are passed straight through.
defineProps<{ title: string }>();

provide(EXPLORER_HOST, useExplorerHost());

// The finder (Ctrl K) is wired here by a later task; until then the box does nothing.
function openFinder() {}
</script>

<template>
	<private-view :title="title">
		<template #navigation>
			<ExplorerNav @open-finder="openFinder" />
		</template>
		<template v-for="(_, name) in $slots" :key="name" #[name]="slotProps">
			<slot :name="name" v-bind="slotProps || {}" />
		</template>
	</private-view>
</template>
