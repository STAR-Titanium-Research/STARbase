<script setup lang="ts">
import { computed, ref } from 'vue';
import './tokens.css';
import {
	LOGINLESS_NOTE, teamBacklogText, teamMembersLabel, teamRoleLabel, waitingMembers, type RoleOption, type TeamAccess, type TeamMembers,
} from '../access/accessModel';
import TeamCard from '../teams/TeamCard.vue';
import TeamFaces from '../teams/TeamFaces.vue';
import TeamTile from '../teams/TeamTile.vue';

// One team on the "Who has access" list: its tile, name and "Team · N members" (hover, focus or tap opens the members card), a face stack,
// and the level with Remove for a manager of the record (everyone else reads the level). A manager also sees "Trust future members" and,
// when joiners wait or were declined, "N waiting · M declined", which expands to Approve / Decline per person (Ruling D2: a member who joins
// after the record was shared gets access only when an owner approves, unless the owner trusts future members).
// The dialog owns the data and the calls; this row only draws them and says what the person asked for.
const props = defineProps<{
	team: TeamAccess;
	canManage: boolean;
	busy: boolean;
	roles: RoleOption[];
	/** Who gets access through this team's grant, once the manager has expanded the row; null before. */
	members: TeamMembers | null;
}>();
const emit = defineEmits<{
	(e: 'role', role: string): void;
	(e: 'remove'): void;
	(e: 'trust', value: boolean): void;
	(e: 'expand'): void;
	(e: 'decide', personId: string, decision: 'approve' | 'decline'): void;
}>();

const expanded = ref(false);
const backlog = computed(() => teamBacklogText(props.team));
const waiting = computed(() => waitingMembers(props.members?.pending ?? []));
const declined = computed(() => props.members?.declined ?? []);

function toggle() {
	expanded.value = !expanded.value;
	if (expanded.value) emit('expand');
}
</script>

<template>
	<li class="row team">
		<TeamCard :team-id="team.team_id">
			<button type="button" class="ident" :aria-label="`${team.name}. ${teamMembersLabel(team.member_count)}. Show members`">
				<TeamTile :team="team" size="md" />
				<span class="who">
					<span class="name">{{ team.name }}</span>
					<span class="sub">{{ teamMembersLabel(team.member_count) }}</span>
				</span>
			</button>
		</TeamCard>
		<TeamFaces :team-id="team.team_id" />
		<span class="grow" />
		<template v-if="canManage">
			<select :value="team.role" :aria-label="`Level of the team ${team.name}`" :disabled="busy" @change="emit('role', ($event.target as HTMLSelectElement).value)">
				<option v-for="r in roles" :key="r.role" :value="r.role">{{ r.label }}</option>
			</select>
			<button type="button" class="btn" :aria-label="`Remove the team ${team.name}`" :disabled="busy" @click="emit('remove')">Remove</button>
		</template>
		<span v-else class="role">{{ teamRoleLabel(team.role) }}</span>

		<div v-if="canManage" class="manage">
			<label class="trust">
				<input type="checkbox" :checked="team.trust_new_members" :disabled="busy" @change="emit('trust', ($event.target as HTMLInputElement).checked)" />
				Trust future members
			</label>
			<button v-if="backlog" type="button" class="backlog" :aria-expanded="expanded" :disabled="busy && !expanded" @click="toggle">
				{{ backlog }}<span aria-hidden="true">{{ expanded ? ' ▴' : ' ▾' }}</span>
			</button>
		</div>

		<div v-if="canManage && expanded && backlog" class="joiners">
			<p v-if="!members" class="hint" role="status">Loading…</p>
			<template v-else>
				<p v-if="!waiting.length && !declined.length" class="hint">Nobody is waiting.</p>
				<ul v-if="waiting.length" class="list" :aria-label="`Waiting to join ${team.name}`">
					<li v-for="m in waiting" :key="m.person_id" class="j">
						<span class="jn">{{ m.name }}<span v-if="!m.can_sign_in" class="tag">{{ LOGINLESS_NOTE }}</span><span class="state">waiting</span></span>
						<button type="button" class="btn small primary" :aria-label="`Approve ${m.name}`" :disabled="busy" @click="emit('decide', m.person_id, 'approve')">Approve</button>
						<button type="button" class="btn small" :aria-label="`Decline ${m.name}`" :disabled="busy" @click="emit('decide', m.person_id, 'decline')">Decline</button>
					</li>
				</ul>
				<ul v-if="declined.length" class="list" :aria-label="`Declined from ${team.name}`">
					<li v-for="m in declined" :key="m.person_id" class="j">
						<span class="jn">{{ m.name }}<span class="state">declined</span></span>
						<button type="button" class="btn small" :aria-label="`Approve ${m.name}`" :disabled="busy" @click="emit('decide', m.person_id, 'approve')">Approve</button>
					</li>
				</ul>
			</template>
		</div>
	</li>
</template>

<style scoped>
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 0; border-top: 1px solid var(--d1-line); font-size: var(--fs-md, 13px); }
.ident {
	display: flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; padding: 2px 4px 2px 0; border: 0; border-radius: 8px; background: transparent; color: inherit;
	font: inherit; text-align: left; cursor: pointer;
}
.ident:hover .name { text-decoration: underline; }
.who { min-width: 0; display: flex; flex-direction: column; }
.name { font-weight: 600; overflow-wrap: anywhere; }
.sub { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.grow { flex: 1; }
.role { color: var(--d1-dim); white-space: nowrap; }
.manage { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding-left: 42px; font-size: var(--fs-sm, 12px); }
.trust { display: inline-flex; align-items: center; gap: 6px; }
.backlog {
	padding: 0; border: 0; background: transparent; color: var(--d1-accent, var(--theme--primary)); font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.backlog:disabled { opacity: 0.55; cursor: default; }
.joiners { flex-basis: 100%; display: flex; flex-direction: column; gap: 6px; margin-left: 42px; padding: 8px 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.j { display: flex; align-items: center; gap: 8px; }
.jn { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; font-weight: 600; overflow-wrap: anywhere; }
.state, .tag { font-size: var(--fs-xs, 11px); font-weight: 400; color: var(--d1-dim); }
.tag { color: var(--d1-warn); }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
select {
	height: 32px; padding: 0 8px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit; font: inherit; font-size: var(--fs-md, 13px);
}
.btn {
	height: 32px; padding: 0 12px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.btn.small { height: 28px; padding: 0 10px; font-size: var(--fs-sm, 12px); }
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.btn:disabled, select:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
