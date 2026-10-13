<script setup lang="ts">
// The STAR group logo and the STARbase name (spec §3.3). Variants:
//  - default: the full logo, dark text on the light theme and light text on the dark theme;
//  - `onDark`: the full logo for the sidebar, which is dark in both themes (always the light text);
//  - `compact`: the star and the name (the phone top bar);
//  - `mark`: only the star, `Star-Icon.svg` (the 60px rail).
defineProps<{ compact?: boolean; mark?: boolean; onDark?: boolean }>();
</script>

<template>
	<span class="sb-logo" :class="{ compact, mark, 'on-dark': onDark }">
		<img v-if="mark" src="/brand/Star-Icon.svg" alt="" class="sb-mark" />
		<template v-else>
			<img v-if="compact" src="/brand/Star-Icon.svg" alt="" class="sb-mark" />
			<img v-else-if="onDark" src="/brand/Star-logo-transparent-light.svg" alt="STAR group" class="sb-wordmark" />
			<picture v-else>
				<source srcset="/brand/Star-logo-transparent-light.svg" media="(prefers-color-scheme: dark)" />
				<img src="/brand/Star-logo-transparent.svg" alt="STAR group" class="sb-wordmark" />
			</picture>
			<span class="sb-name">STARbase</span>
		</template>
	</span>
</template>

<style scoped>
.sb-logo { display: inline-flex; align-items: center; gap: 10px; color: var(--theme--foreground); text-decoration: none; }
.sb-logo.on-dark { color: var(--d1-side-text, #fff); }
.sb-wordmark { height: 32px; width: auto; }
.sb-mark { height: 28px; width: 28px; }
.sb-name { font-size: var(--fs-lg, 15px); font-weight: 800; letter-spacing: 0.01em; }
</style>
