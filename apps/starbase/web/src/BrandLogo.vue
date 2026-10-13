<script setup lang="ts">
// The STAR group logo and the STARbase name (spec §3.3): dark text on the light theme, light text on the
// dark theme. `compact` shows only the star (the phone top bar).
defineProps<{ compact?: boolean }>();
</script>

<template>
	<span class="sb-logo" :class="{ compact }">
		<img v-if="compact" src="/brand/Star-Icon.svg" alt="" class="sb-mark" />
		<picture v-else>
			<source srcset="/brand/Star-logo-transparent-light.svg" media="(prefers-color-scheme: dark)" />
			<img src="/brand/Star-logo-transparent.svg" alt="STAR group" class="sb-wordmark" />
		</picture>
		<span class="sb-name">STARbase</span>
	</span>
</template>

<style scoped>
.sb-logo { display: inline-flex; align-items: center; gap: 10px; color: var(--theme--foreground); text-decoration: none; }
.sb-wordmark { height: 32px; width: auto; }
.sb-mark { height: 28px; width: 28px; }
.sb-name { font-size: var(--fs-lg, 15px); font-weight: 800; letter-spacing: 0.01em; }
</style>
