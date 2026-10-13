<script setup lang="ts">
import { onBeforeUnmount, provide } from 'vue';
import { EXPLORER_HOST, useExplorerHost } from '@d1/ui';
import { usePageFrame } from './frame';
import ScanDialog from './scan/ScanDialog.vue';
import { scanOpen } from './scan/scanState';

// Every page renders inside this: it hands the page's slots to the host's frame and provides the
// host for any component that still injects it (the kit components now ask useExplorerHost() themselves, so they also work outside this view). A page uses it
// where it used <private-view>: same title, same slots (headline, title-outer:prepend, actions, ...),
// which are passed straight through.
defineProps<{ title: string }>();
provide(EXPLORER_HOST, useExplorerHost());
const Frame = usePageFrame();

// The camera scan dialog is the pages' own (the Home Scan tile opens it too), so it lives here, not in
// a host's frame; the frame's Finder only calls openScan() (scanState.ts).
// Every Explorer page has its own ExplorerView, and scanOpen is shared: a dialog still open when the
// page goes away (browser Back, a link) must not open again on the next page.
onBeforeUnmount(() => {
	scanOpen.value = false;
});
</script>

<template>
	<component :is="Frame" :title="title">
		<template v-for="(_, name) in $slots" :key="name" #[name]="slotProps"><slot :name="name" v-bind="slotProps || {}" /></template>
	</component>
	<ScanDialog v-if="scanOpen" @close="scanOpen = false" />
</template>
