<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { EXPLORER_HOST } from '../host';
import { useRequestGate } from '../composables/useRequestGate';
import { loadTeamHits, searchPeople } from '../access/accessApi';
import {
	LOGINLESS_NOTE, addable, isLoginless, isTeamHit, teamMembersLabel, teamsMatching, type AccessList, type PersonHit, type TeamHit,
} from '../access/accessModel';
import { moveIndex } from '../finder/finderNav';
import TeamTile from '../teams/TeamTile.vue';

// The add box of the "Who has access" dialog: a combobox that searches active People by name (the same /items/people the People
// page reads) and, with `teams`, the teams too (GET /d1-teams, read once and filtered by name here). A person with no login can be picked
// and is marked "can't sign in yet": the grant starts working the day an admin links a login to them. People and teams already on the list
// are left out; for a transfer (`entries: false`) only the owner is. People come first, then teams.
// Enter picks the highlighted row, the arrow keys move, Escape closes the list (and only then: a second Escape closes the dialog).
const props = withDefaults(
	defineProps<{
		list: (Pick<AccessList, 'owner' | 'entries'> & Partial<Pick<AccessList, 'teams'>>) | null;
		label: string;
		placeholder?: string;
		entries?: boolean;
		/** Offer teams as well as people. */
		teams?: boolean;
		disabled?: boolean;
	}>(),
	{ placeholder: 'Add people by name…', entries: true, teams: false },
);
const emit = defineEmits<{ (e: 'pick', hit: PersonHit | TeamHit): void }>();

const host = inject(EXPLORER_HOST);
if (!host) throw new Error('AccessPersonPicker needs an ExplorerHost: render it inside ExplorerView');

const uid = `d1-access-pick-${Math.random().toString(36).slice(2, 8)}`;
const text = ref('');
const hits = ref<PersonHit[]>([]);
// Every team, read on the first search and kept while the box is mounted; `searched` is the text the shown rows answer.
const allTeams = ref<TeamHit[] | null>(null);
const searched = ref('');
const searching = ref(false);
const failed = ref('');
const open = ref(false);
const active = ref(-1);
const input = ref<HTMLInputElement | null>(null);
const gate = useRequestGate();
let timer: ReturnType<typeof setTimeout> | null = null;

const shown = computed<(PersonHit | TeamHit)[]>(() => {
	const list = props.list ?? { owner: null, entries: [] };
	const people = addable(hits.value, props.entries ? list : { owner: list.owner, entries: [] });
	const teams = props.teams && allTeams.value ? teamsMatching(allTeams.value, searched.value, list) : [];
	return [...people, ...teams];
});
const keyOf = (hit: PersonHit | TeamHit) => (isTeamHit(hit) ? `team-${hit.team_id}` : hit.person_id);
const activeId = computed(() => (active.value >= 0 && active.value < shown.value.length ? `${uid}-opt-${active.value}` : undefined));

watch(text, (value) => {
	if (timer) clearTimeout(timer);
	failed.value = '';
	if (!value.trim()) {
		gate.cancel();
		hits.value = [];
		searching.value = false;
		open.value = false;
		return;
	}
	searching.value = true;
	timer = setTimeout(async () => {
		const token = gate.begin();
		const [res, teamRes] = await Promise.all([searchPeople(host.api, value), props.teams && !allTeams.value ? loadTeamHits(host.api) : null]);
		if (!gate.isCurrent(token)) return;
		searching.value = false;
		if (teamRes?.ok) allTeams.value = teamRes.data;
		searched.value = value;
		if (res.ok) {
			hits.value = res.data;
			// the people are shown either way; a failed team list is said, not hidden
			failed.value = teamRes && !teamRes.ok ? `Teams could not be listed: ${teamRes.message}` : '';
		} else {
			hits.value = [];
			failed.value = res.message;
		}
		open.value = true;
		active.value = shown.value.length ? 0 : -1;
	}, 250);
});
onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	gate.cancel();
});

function pick(hit: PersonHit | TeamHit) {
	emit('pick', hit);
	text.value = '';
	hits.value = [];
	open.value = false;
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		if (!shown.value.length) return;
		e.preventDefault();
		open.value = true;
		active.value = moveIndex(active.value, e.key === 'ArrowDown' ? 1 : -1, shown.value.length);
	} else if (e.key === 'Enter') {
		if (e.isComposing) return;
		e.preventDefault();
		const hit = shown.value[active.value];
		if (open.value && hit) pick(hit);
	} else if (e.key === 'Escape' && open.value) {
		e.preventDefault();
		e.stopPropagation();
		open.value = false;
	}
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
	<div class="d1-access-pick">
		<input
			ref="input"
			v-model="text"
			type="text"
			role="combobox"
			class="q"
			:placeholder="placeholder"
			:aria-label="label"
			aria-autocomplete="list"
			:aria-expanded="open && shown.length > 0"
			:aria-controls="`${uid}-list`"
			:aria-activedescendant="activeId"
			autocomplete="off"
			spellcheck="false"
			:disabled="disabled"
			@keydown="onKeydown"
			@focus="open = shown.length > 0"
		/>
		<ul v-show="open && shown.length" :id="`${uid}-list`" class="opts" role="listbox" :aria-label="`${label}: matches`">
			<!-- mousedown.prevent: a click must not take focus off the box before the pick lands. -->
			<li
				v-for="(p, i) in shown"
				:id="`${uid}-opt-${i}`"
				:key="keyOf(p)"
				role="option"
				class="opt"
				:class="{ on: i === active }"
				:aria-selected="i === active"
				@mousedown.prevent
				@mousemove="active = i"
				@click="pick(p)"
			>
				<template v-if="isTeamHit(p)">
					<TeamTile :team="p" size="sm" />
					<span class="n">{{ p.name }}</span>
					<span class="sub">{{ teamMembersLabel(p.member_count) }}</span>
				</template>
				<template v-else>
					<span class="n">{{ p.full_name }}</span>
					<span v-if="isLoginless(p)" class="tag">{{ LOGINLESS_NOTE }}</span>
				</template>
			</li>
		</ul>
		<p class="hint" role="status" aria-live="polite">
			<template v-if="failed">{{ failed }}</template>
			<template v-else-if="searching">Searching…</template>
			<template v-else-if="text.trim() && open && !shown.length">No one matches ({{ teams ? 'people and teams' : 'people' }} already on the list are left out).</template>
		</p>
	</div>
</template>

<style scoped>
.d1-access-pick { position: relative; min-width: 0; flex: 1; }
.q {
	width: 100%; box-sizing: border-box; height: 38px; padding: 0 12px;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px);
}
.q:focus { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.opts {
	position: absolute; z-index: 2; left: 0; right: 0; margin: 4px 0 0; padding: 4px; list-style: none; max-height: 240px; overflow-y: auto;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
.sub { font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; }
.opt { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; font-size: var(--fs-md, 13px); cursor: pointer; }
.opt.on { background: var(--d1-tile); outline: 1px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.tag { font-size: var(--fs-xs, 11px); color: var(--d1-warn); white-space: nowrap; }
.hint { margin: 4px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.hint:empty { display: none; }
</style>
