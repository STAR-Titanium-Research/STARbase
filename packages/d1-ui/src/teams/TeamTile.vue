<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import '../components/tokens.css';
import { assetUrl } from '../links';
import { lightDark, teamInitials, type TeamColor } from './teamPalette';

// A team's square tile: its logo (a Directus file, through /assets) or, with no logo, the first letters of the first two words of its
// name on the team's palette colour. Text and background are one of the audited pairs of teamPalette.ts (4.5:1 or better in light and
// dark), switched with light-dark(). The tile is decoration: the name is always written next to it, so it is hidden from screen readers.
const props = withDefaults(
	defineProps<{
		team: { name: string; color: TeamColor; logo?: string | null };
		size?: 'sm' | 'md' | 'lg';
	}>(),
	{ size: 'md' },
);

const PX = { sm: 24, md: 32, lg: 48 } as const;

// A logo that fails to load (deleted file, no permission) falls back to the initials instead of a broken image.
const broken = ref(false);
watch(() => props.team.logo, () => (broken.value = false));

const px = computed(() => PX[props.size]);
const src = computed(() => (props.team.logo && !broken.value ? assetUrl(props.team.logo, { width: px.value * 2, height: px.value * 2, fit: 'cover', format: 'webp' }) : null));
const initials = computed(() => teamInitials(props.team.name));
const style = computed(() => ({
	'--tt-size': `${px.value}px`,
	'--tt-bg': lightDark(props.team.color, 'bg'),
	'--tt-fg': lightDark(props.team.color, 'fg'),
}));
</script>

<template>
	<span class="d1-team-tile" :class="[`s-${size}`, { logo: !!src }]" :style="style" aria-hidden="true">
		<img v-if="src" :src="src" alt="" draggable="false" @error="broken = true" />
		<template v-else>{{ initials }}</template>
	</span>
</template>

<style scoped>
.d1-team-tile {
	flex: 0 0 auto; box-sizing: border-box; width: var(--tt-size); height: var(--tt-size); display: inline-grid; place-items: center; overflow: hidden;
	border-radius: 22%; background: var(--tt-bg); color: var(--tt-fg); font-weight: 700; line-height: 1; letter-spacing: 0.02em; user-select: none;
}
/* A logo has its own background (often transparent): give it the panel colour and a hairline so it reads as a tile. */
.d1-team-tile.logo { background: var(--d1-surface, #fff); border: 1px solid var(--d1-line, transparent); }
.d1-team-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.s-sm { font-size: var(--fs-xs, 11px); }
.s-md { font-size: var(--fs-md, 13px); }
.s-lg { font-size: var(--fs-xl, 18px); }
</style>
