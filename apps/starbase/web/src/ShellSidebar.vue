<script setup lang="ts">
import { ExplorerNav, type SectionId } from '@d1/ui';
import BrandLogo from './BrandLogo.vue';
import ShellFoot from './ShellFoot.vue';

// One sidebar as the shell draws it, in any of its homes (the desktop column, the overlay at 768-999 px,
// the phone sheet): the brand (the full logo expanded, the star mark on the rail), the Explorer sidebar
// and the account foot (compact under the rail). The shell decides `mode` and answers `request-mode`.
withDefaults(defineProps<{ mode: 'expanded' | 'rail'; collapsible?: boolean; openSection?: SectionId | null; brand?: boolean }>(), {
	collapsible: false,
	openSection: null,
	brand: true,
});
defineEmits<{
	(e: 'open-finder'): void;
	(e: 'request-mode', mode: 'expanded' | 'rail', sectionId?: SectionId): void;
}>();
</script>

<template>
	<router-link v-if="brand && mode === 'expanded'" to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo on-dark /></router-link>
	<ExplorerNav
		class="sb-nav"
		:show-brand="false"
		:mode="mode"
		:collapsible="collapsible"
		:open-section="openSection"
		@open-finder="$emit('open-finder')"
		@request-mode="(m, s) => $emit('request-mode', m, s)"
	>
		<template #mark>
			<router-link to="/" class="sb-brand-mark" aria-label="STARbase Home"><BrandLogo mark /></router-link>
		</template>
	</ExplorerNav>
	<ShellFoot :compact="mode === 'rail'" />
</template>

<style scoped>
.sb-brand { display: flex; align-items: center; height: 64px; padding: 0 16px; flex: none; text-decoration: none; }
.sb-brand-mark { display: inline-flex; padding: 6px; border-radius: 8px; }
.sb-brand-mark:focus-visible, .sb-brand:focus-visible { outline: 2px solid var(--d1-side-bar); outline-offset: -2px; }
.sb-nav { flex: 1 0 auto; }
</style>
