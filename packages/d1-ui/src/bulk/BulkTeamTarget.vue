<script setup lang="ts">
// The target step of Assign to team: the teams as a list of tiles, one radio each (the arrow keys move between them, Tab leaves the
// list). Choosing one starts the dry run. The list is GET /d1-teams, loaded by useBulkActions when the dialog opens.
import { computed } from 'vue';
import { teamMembersLabel } from '../access/accessModel';
import TeamTile from '../teams/TeamTile.vue';
import type { BulkState } from './useBulkActions';

const props = defineProps<{ bulk: BulkState }>();
const chosen = computed(() => props.bulk.dialog?.choice?.value ?? '');
const name = `d1-bulk-team-${Math.random().toString(36).slice(2, 8)}`;
</script>

<template>
	<fieldset class="teams" :disabled="bulk.applying">
		<legend>Team</legend>
		<p v-if="bulk.optionsState.loading" class="hint">Loading teams…</p>
		<p v-else-if="!bulk.teamOptions.length && !bulk.optionsState.error" class="hint">There are no teams yet.</p>
		<div v-else class="list">
			<label v-for="t in bulk.teamOptions" :key="t.team_id" class="team" :class="{ on: chosen === t.team_id }">
				<input type="radio" :name="name" :value="t.team_id" :checked="chosen === t.team_id" @change="bulk.choose(t.team_id, t.name, 'team')" />
				<TeamTile :team="t" size="sm" />
				<span class="n">{{ t.name }}</span>
				<span class="sub">{{ teamMembersLabel(t.member_count) }}</span>
			</label>
		</div>
	</fieldset>
</template>

<style scoped>
.teams { margin: 0; padding: 0; border: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
legend { padding: 0; margin-bottom: 4px; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.team { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px; font-size: var(--fs-md, 13px); cursor: pointer; }
.team:hover { background: var(--d1-tile); }
.team.on { background: var(--d1-tile); border-color: var(--d1-accent, var(--theme--primary)); }
.team input { margin: 0; accent-color: var(--d1-accent, var(--theme--primary)); }
.team:has(input:focus-visible) { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.sub { margin-left: auto; font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
</style>
