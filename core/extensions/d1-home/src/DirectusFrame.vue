<script setup lang="ts">
import { ExplorerNav, Finder, useFinderShortcut } from '@d1/ui';
import { openScan } from '@d1/starbase-pages';

// The Directus side of the page frame: Directus's own <private-view> with the Explorer sidebar and the
// finder in its navigation column; STARbase installs its own shell instead. A page uses the frame
// exactly where it used <private-view>: same title, same slots, passed straight through.
defineProps<{ title: string }>();

// The finder dialog: opened by the sidebar's box and by Ctrl K / Cmd K anywhere in the app.
const { finderOpen, openFinder, closeFinder } = useFinderShortcut();

// The Finder's Scan button hands over to the camera dialog (the one Home's Scan tile also opens;
// ExplorerView hosts it).
const scanFromFinder = () => {
	closeFinder();
	openScan();
};

// The sidebar's rail is as tall as the navigation column, which sits under Directus's 54px header
// bar (the same bar the pages' sticky rail clears with --d1-sticky-top: 70px, bar plus a gap): the
// rail is told so with --d1-nav-offset, set on the sidebar below.
</script>

<template>
	<private-view :title="title">
		<template #navigation>
			<ExplorerNav :show-brand="false" style="--d1-nav-offset: 54px" @open-finder="openFinder" />
			<Finder v-if="finderOpen" can-scan @close="closeFinder" @scan="scanFromFinder" />
		</template>
		<template v-for="(_, name) in $slots" :key="name" #[name]="slotProps">
			<slot :name="name" v-bind="slotProps || {}" />
		</template>
	</private-view>
</template>
