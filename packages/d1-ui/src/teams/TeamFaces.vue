<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import '../components/tokens.css';
import { EXPLORER_HOST } from '../host';
import { initials } from '../access/accessModel';
import { cachedTeam, onTeamChange, type TeamMember } from './teamsApi';

// A small stack of overlapping initials circles: the first few members of a team and "+N" for the rest. Read through the page's team cache
// (the same read as the members card), so a dialog with several teams asks the server once per team. Decoration only (aria-hidden): the
// row already says how many members the team has. A team that cannot be read shows nothing.
const props = withDefaults(defineProps<{ teamId: string; max?: number }>(), { max: 3 });

const host = inject(EXPLORER_HOST);
const members = ref<TeamMember[]>([]);
let seq = 0;
let shownFor = '';

async function load() {
	const mine = ++seq;
	// another team: clear; the same team read again keeps the old faces until the new ones arrive (no flicker)
	if (shownFor !== props.teamId) members.value = [];
	if (!host) return;
	try {
		const d = await cachedTeam(host.api, props.teamId);
		if (mine === seq) {
			members.value = d.members;
			shownFor = props.teamId;
		}
	} catch {
		// nothing to show
	}
}
// A member added or removed through teamsApi drops the kept read: read again, so the stack is not stale.
let stop: (() => void) | null = null;
function follow() {
	stop?.();
	stop = onTeamChange(props.teamId, () => void load());
}
onMounted(() => {
	follow();
	void load();
});
watch(() => props.teamId, () => {
	follow();
	void load();
});
onBeforeUnmount(() => stop?.());

const faces = computed(() => members.value.slice(0, props.max));
const rest = computed(() => Math.max(0, members.value.length - props.max));
</script>

<template>
	<span v-if="faces.length" class="d1-team-faces" aria-hidden="true">
		<span v-for="m in faces" :key="m.person_id" class="face">{{ initials(m.full_name || '?') }}</span>
		<span v-if="rest" class="face more">+{{ rest }}</span>
	</span>
</template>

<style scoped>
.d1-team-faces { display: inline-flex; align-items: center; flex: 0 0 auto; }
.face {
	box-sizing: border-box; width: 24px; height: 24px; margin-left: -6px; display: grid; place-items: center; border-radius: 50%;
	border: 2px solid var(--d1-surface); background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 18%, var(--d1-surface)); font-size: var(--fs-xs, 11px); font-weight: 700;
}
.face:first-child { margin-left: 0; }
.face.more { background: var(--d1-tile); color: var(--d1-dim); }
</style>
