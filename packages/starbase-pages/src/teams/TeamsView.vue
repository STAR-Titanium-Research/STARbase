<script setup lang="ts">
// The Teams view of the People page (?view=teams): a row per team (tile, name, description, member count, managers), the chips All and
// My teams, and New team (anyone may start one and becomes its manager). A row opens the team's page; the tile and name carry the members
// card (TeamCard) on hover or focus. People opens this inside its own header, so it draws no header of its own.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { TeamCard, TeamTile, useExplorerHost, useRequestGate, listTeams } from '@d1/ui';
import type { TeamSummary } from '@d1/ui';
import TeamEditDialog from './TeamEditDialog.vue';
import { managersLine, plural, teamsShown, tileOf } from './teamPage';

const host = useExplorerHost();
const { canViewAllAccess } = host; // a Lab Viewer reads the teams and starts none
const gate = useRequestGate();

const teams = ref<TeamSummary[] | null>(null);
const loadError = ref('');
const chip = ref<'all' | 'mine'>('all');

async function load() {
	const token = gate.begin();
	try {
		const rows = await listTeams(host.api);
		if (!gate.isCurrent(token)) return;
		teams.value = [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		loadError.value = '';
	} catch (e: any) {
		if (!gate.isCurrent(token)) return;
		loadError.value = e?.message || 'Could not load the teams.';
	}
}
onMounted(() => void load());
onBeforeUnmount(() => gate.cancel());

const all = computed(() => teams.value ?? []);
const mine = computed(() => teamsShown(all.value, 'mine'));
const shown = computed(() => teamsShown(all.value, chip.value));

const open = (t: TeamSummary) => host.navigate(`/home/teams/${encodeURIComponent(t.team_id)}`);

const creating = ref(false);
const created = (t: TeamSummary) => open(t);
</script>

<template>
	<div class="teams">
		<div class="bar">
			<button type="button" class="fc" :class="{ on: chip === 'all' }" :aria-pressed="chip === 'all'" @click="chip = 'all'">All <span class="n">{{ all.length }}</span></button>
			<button type="button" class="fc" :class="{ on: chip === 'mine' }" :aria-pressed="chip === 'mine'" @click="chip = 'mine'">My teams <span class="n">{{ mine.length }}</span></button>
			<div class="grow" />
			<v-button v-if="!canViewAllAccess" small @click="creating = true"><v-icon name="group_add" left small />New team</v-button>
		</div>

		<v-progress-circular v-if="!teams && !loadError" indeterminate class="load" />
		<v-notice v-else-if="loadError && !teams" type="danger">{{ loadError }}</v-notice>
		<div v-else-if="!shown.length" class="empty">{{ chip === 'mine' ? 'You are not in a team yet.' : 'No teams yet.' }}</div>
		<ul v-else class="list" aria-label="Teams">
			<li v-for="t in shown" :key="t.team_id" class="row">
				<TeamCard :team-id="t.team_id">
					<template #default="{ triggerAttrs }">
						<button type="button" class="who" v-bind="triggerAttrs" @click="open(t)">
							<TeamTile :team="tileOf(t)" size="md" />
							<span class="nm">{{ t.name }}</span>
						</button>
					</template>
				</TeamCard>
				<span class="desc">{{ t.description }}</span>
				<span class="cnt">{{ plural(t.member_count, 'member') }}</span>
				<span class="mgrs">{{ t.managers.length ? `Managed by ${managersLine(t.managers)}` : 'No manager' }}</span>
			</li>
		</ul>

		<TeamEditDialog v-model="creating" :team="null" @saved="created" @partial="load()" />
	</div>
</template>

<style scoped>
.teams { display: flex; flex-direction: column; gap: 12px; }
.bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.grow { flex: 1; }
.fc { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--d1-line); background: var(--d1-surface); border-radius: 99px;
	font: inherit; font-size: var(--fs-sm); font-weight: 600; line-height: 1; color: var(--d1-dim); cursor: pointer; }
.fc:hover { color: var(--theme--foreground); }
.fc.on { background: var(--d1-accent, var(--theme--primary, #1d4ed8)); border-color: var(--d1-accent, var(--theme--primary, #1d4ed8)); color: var(--d1-on-accent, #fff); }
.fc .n { opacity: .75; font-weight: 700; margin-left: 5px; font-variant-numeric: tabular-nums; }
.load, .empty { display: block; margin: 40px auto; text-align: center; color: var(--d1-dim); }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; background: var(--d1-surface); border: 1px solid var(--d1-line);
	border-radius: var(--d1-radius); box-shadow: var(--d1-shadow); overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(160px, 1.1fr) minmax(0, 2fr) auto minmax(0, 1.2fr); gap: 4px 16px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--d1-line); }
.row:first-child { border-top: 0; }
.row:hover { background: var(--d1-tile); }
.who { display: inline-flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit; font-weight: 700; text-align: left; cursor: pointer; }
.who:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 6px; }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desc, .mgrs { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--d1-dim); font-size: var(--fs-sm); }
.cnt { font-size: var(--fs-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (max-width: 720px) {
	.row { grid-template-columns: minmax(0, 1fr) auto; }
	.desc, .mgrs { grid-column: 1 / -1; white-space: normal; }
}
</style>
