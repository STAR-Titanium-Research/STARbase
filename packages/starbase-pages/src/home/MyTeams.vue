<script setup lang="ts">
// "My teams": the records of the viewer's own teams that changed most recently, one line each (team tile, kind, code, title, when). It
// draws nothing at all when the viewer is in no team, when no record of those teams is readable to them, and when the list cannot be read
// (a block of Home never draws an empty box or blanks the page). Ruling M1: the endpoint returns only records the viewer can read.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { AppLink, RecordLink, Section, TeamTile, myRecentTeamRecords, useExplorerHost, useRequestGate } from '@d1/ui';
import type { RecentTeamRecord } from '@d1/ui';
import { PANEL_MORE, PANEL_SHOWN, panelLines, recordLabel, showMoreLabel } from './myTeamsPanel';

const host = useExplorerHost();
const gate = useRequestGate();
const items = ref<RecentTeamRecord[]>([]);
const expanded = ref(false);
const list = ref<HTMLUListElement | null>(null);

async function load() {
	const token = gate.begin();
	try {
		const rows = await myRecentTeamRecords(host.api, PANEL_MORE);
		if (gate.isCurrent(token)) items.value = rows;
	} catch {
		// the panel is an extra: a failed read leaves it out rather than showing an error
		if (gate.isCurrent(token)) items.value = [];
	}
}
onMounted(() => void load());
onBeforeUnmount(() => gate.cancel());

const lines = computed(() => panelLines(items.value, expanded.value));
const moreLabel = computed(() => showMoreLabel(items.value.length, expanded.value));

// The button unmounts when it is pressed, so keyboard focus would fall to <body>: move it to the first revealed line instead.
async function showMore() {
	expanded.value = true;
	await nextTick();
	const first = list.value?.children[PANEL_SHOWN] as HTMLElement | undefined;
	(first?.querySelector<HTMLElement>('a') ?? first)?.focus();
}
</script>

<template>
	<Section v-if="lines.length" title="My teams">
		<template #actions><AppLink to="/home/people?view=teams" class="link">All teams →</AppLink></template>
		<ul ref="list" class="lines">
			<li v-for="l in lines" :key="l.key" class="line" tabindex="-1">
				<TeamTile :team="l.team" size="sm" />
				<span class="kind">{{ l.kind }}</span>
				<RecordLink :collection="l.collection" :id="l.id" class="code" :aria-label="recordLabel(l)">{{ l.code }}</RecordLink>
				<span class="title">{{ l.title }}</span>
				<span class="team">{{ l.team.name }}</span>
				<span v-if="l.changed" class="when">{{ l.changed }}</span>
			</li>
		</ul>
		<button v-if="moreLabel" type="button" class="more" @click="showMore">{{ moreLabel }}</button>
	</Section>
</template>

<style scoped>
.link { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; font-size: var(--fs-sm); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.lines { list-style: none; margin: 0; padding: 0; }
.line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; padding: 6px 0; border-top: 1px solid var(--d1-line); }
.line:focus { outline: none; }
.line:first-child { border-top: 0; padding-top: 0; }
.kind {
	font-size: var(--fs-xs, 11px); font-weight: 700; padding: 1px 8px; border-radius: 99px; white-space: nowrap;
	color: var(--d1-dim); background: var(--theme--background-normal);
}
.code { overflow-wrap: anywhere; }
.title { min-width: 0; flex: 1 1 12ch; color: var(--d1-dim); overflow-wrap: anywhere; }
.team, .when { font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; }
.more { margin-top: 8px; border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; cursor: pointer; }
</style>
