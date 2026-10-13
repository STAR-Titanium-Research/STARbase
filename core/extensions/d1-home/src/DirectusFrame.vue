<script setup lang="ts">
import { ExplorerNav, Finder, starbaseUrlFor, starbaseUrlOnce, useExplorerHost, useFinderShortcut } from '@d1/ui';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
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

// Q12: a quiet "Open in STARbase" under the sidebar, to the same page there. Hidden while STARBASE_URL
// is unset or /d1-links is not deployed.
const host = useExplorerHost();
const route = useRoute();
const starbaseUrl = ref<string | null>(null);
onMounted(async () => {
	starbaseUrl.value = await starbaseUrlOnce(host.api);
});
const starbaseHref = computed(() => (starbaseUrl.value ? starbaseUrlFor(starbaseUrl.value, route.fullPath) : null));

// The sidebar's rail is as tall as the navigation column, which sits under Directus's 54px header
// bar (the same bar the pages' sticky rail clears with --d1-sticky-top: 70px, bar plus a gap): the
// rail is told so with --d1-nav-offset, set on the sidebar below.
</script>

<template>
	<private-view :title="title">
		<template #navigation>
			<ExplorerNav :show-brand="false" style="--d1-nav-offset: 54px" @open-finder="openFinder" />
			<Finder v-if="finderOpen" can-scan @close="closeFinder" @scan="scanFromFinder" />
			<a v-if="starbaseHref" class="d1-open-starbase" :href="starbaseHref" target="_blank" rel="noopener">Open in STARbase</a>
		</template>
		<template v-for="(_, name) in $slots" :key="name" #[name]="slotProps">
			<slot :name="name" v-bind="slotProps || {}" />
		</template>
	</private-view>
</template>

<style scoped>
/* The nav (rail + panel) is exactly as tall as the navigation column, so the link would sit just below
   the fold: pin it to the column's bottom edge, and to the right of the 60px rail. */
.d1-open-starbase {
	display: block; position: sticky; bottom: 0; margin: 0 0 0 60px; padding: 8px 12px 12px; font-size: var(--fs-xs, 11px);
	background: var(--theme--navigation--background, var(--theme--background-subdued));
	color: var(--theme--foreground-subdued); text-decoration: none;
}
.d1-open-starbase:hover { text-decoration: underline; }
</style>
