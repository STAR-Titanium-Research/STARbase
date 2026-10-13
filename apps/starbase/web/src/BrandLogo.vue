<script setup lang="ts">
// The STAR group star mark, `Star-Icon.svg`, with no lettering anywhere (the `Star-logo-transparent*`
// files carry the "STAR" lettering as vector paths, so they are not used). One image, sized per place:
//  - default: the sign-in and notice pages (`size` overrides it);
//  - `onDark`: the sidebar brand row (64px tall; the sidebar is dark in both themes);
//  - `compact`: the phone top bar;
//  - `mark`: the 60px rail.
// The image is named "STARbase" for screen readers.
defineProps<{ compact?: boolean; mark?: boolean; onDark?: boolean; size?: number }>();
</script>

<template>
	<span class="sb-logo" :class="{ compact, mark, 'on-dark': onDark }">
		<img src="/brand/Star-Icon.svg" alt="STARbase" class="sb-mark" :style="size ? { height: size + 'px', width: size + 'px' } : undefined" />
	</span>
</template>

<style scoped>
.sb-logo { display: inline-flex; align-items: center; color: var(--theme--foreground); text-decoration: none; }
.sb-logo.on-dark { color: var(--d1-side-text, #fff); }
.sb-mark { height: 48px; width: 48px; display: block; }
.on-dark .sb-mark { height: 36px; width: 36px; }
.compact .sb-mark { height: 32px; width: 32px; }
.mark .sb-mark { height: 28px; width: 28px; }
</style>
