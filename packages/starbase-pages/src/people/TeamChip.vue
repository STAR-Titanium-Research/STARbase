<script setup lang="ts">
// A small team chip: the team's logo (when it has one) or a dot in its colour, then its name. The colour is one of the palette keys the
// teams table allows (teal, blue, indigo, violet, pink, red, orange, amber, green, slate). With `to` set it is a button that opens that
// team's page. Task 6 builds the real TeamTile in @d1/ui; this stands in for it on the People page.
import { computed } from 'vue';
import { assetUrl } from '@d1/ui';
import { teamColorClass } from './teamColor';

const props = defineProps<{
	team: { team_id: string; name: string; color: string; logo?: string | null; is_manager?: boolean };
	/** Show the chip as a button (the click is the parent's). */
	clickable?: boolean;
}>();
const emit = defineEmits<{ (e: 'open', teamId: string): void }>();

const logoSrc = computed(() => (props.team.logo ? assetUrl(props.team.logo, { width: 32, height: 32, fit: 'cover', format: 'webp' }) : null));
const cls = computed(() => teamColorClass(props.team.color));
</script>

<template>
	<component
		:is="clickable ? 'button' : 'span'"
		class="team-chip"
		:class="cls"
		:type="clickable ? 'button' : undefined"
		:title="team.is_manager ? `${team.name} (manager)` : team.name"
		@click="clickable && emit('open', team.team_id)"
	>
		<img v-if="logoSrc" class="logo" :src="logoSrc" alt="" />
		<span v-else class="dot" aria-hidden="true" />
		<span class="nm">{{ team.name }}</span>
		<span v-if="team.is_manager" class="mgr">manager</span>
	</component>
</template>

<style scoped>
/* One hue per palette key; the chip mixes it into the page's own foreground and surface, so it reads in light and dark. */
.team-chip { --tc: #0d9488; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 24px; padding: 0 10px 0 6px; border: 1px solid color-mix(in srgb, var(--tc) 35%, transparent);
	border-radius: 99px; background: color-mix(in srgb, var(--tc) 14%, transparent); color: color-mix(in srgb, var(--tc) 65%, var(--theme--foreground, #111)); font: inherit; font-size: var(--fs-sm);
	font-weight: 600; line-height: 1; }
button.team-chip { cursor: pointer; }
button.team-chip:hover { background: color-mix(in srgb, var(--tc) 22%, transparent); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--tc); flex: 0 0 auto; }
.logo { width: 16px; height: 16px; border-radius: 4px; object-fit: cover; flex: 0 0 auto; }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mgr { font-size: var(--fs-xs); font-weight: 500; opacity: .75; }
.c-teal { --tc: #0d9488; }
.c-blue { --tc: #2563eb; }
.c-indigo { --tc: #4f46e5; }
.c-violet { --tc: #7c3aed; }
.c-pink { --tc: #db2777; }
.c-red { --tc: #dc2626; }
.c-orange { --tc: #ea580c; }
.c-amber { --tc: #d97706; }
.c-green { --tc: #16a34a; }
.c-slate { --tc: #64748b; }
</style>
