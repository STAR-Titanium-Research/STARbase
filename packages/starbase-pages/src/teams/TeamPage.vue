<script setup lang="ts">
// A team's page (/teams/:id): the team (tile, name, description, "N members · M records"), its Members (a manager badge; Add member, Make
// manager / Remove manager and Remove for managers and administrators; Leave for oneself), its Records (the counts per level are for
// everyone; the list holds only the records the viewer may read, then "and N you can't see") and its History (the last 20, "Show all").
// Every change goes through the d1-teams endpoint; its own words (LAST_MANAGER, a refused delete) are shown as they come. A team that owns
// records (they show as "Owns", with the owner grant listed as role Owns) cannot be deleted: Delete says what it owns (TEAM_OWNS_RECORDS).
import ExplorerView from '../ExplorerView.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AppLink, PageShell, RecordLink, Section, TeamTile, deleteTeam, formatDate, getTeam, removeMember, setManager, useExplorerHost, useRequestGate } from '@d1/ui';
import type { TeamDetail, TeamMember } from '@d1/ui';
import AddMemberDialog from './AddMemberDialog.vue';
import TeamEditDialog from './TeamEditDialog.vue';
import { canManage, deleteRefusal, hiddenLine, historyLabel, levelCounts, managersLine, membersAndRecords, tileOf } from './teamPage';
import { kindLabel, levelLabel } from '../people/personPanel';

const props = defineProps<{ id: string }>();

const host = useExplorerHost();
const { isAdmin, canViewAllAccess } = host; // a Lab Viewer reads the team and changes nothing
const gate = useRequestGate();
const BACK = '/home/people?view=teams';

const detail = ref<TeamDetail | null>(null);
const loading = ref(true);
const loadError = ref('');
const showAll = ref(false);
const loadingAll = ref(false);
const actionError = ref('');
const busy = ref(false);
const editOpen = ref(false);
const addOpen = ref(false);
// The caller's own person (members are people; the login's id is not a member id), found once the team says they are in it.
const ownPersonId = ref<string | null>(null);

const team = computed(() => detail.value?.team ?? null);
const members = computed(() => detail.value?.members ?? []);
const manage = computed(() => canManage(team.value, isAdmin.value, canViewAllAccess.value));
const levels = computed(() => (detail.value ? levelCounts(detail.value.counts) : []));
const summary = computed(() => (detail.value ? membersAndRecords(detail.value.members.length, detail.value.counts) : ''));
const recordsTotal = computed(() => {
	const c = detail.value?.counts;
	return c ? c.view + c.edit + c.investigator + (c.owns ?? 0) : 0;
});
const hidden = computed(() => hiddenLine(detail.value?.hidden_count ?? 0));
const events = computed(() => detail.value?.events ?? []);
const canShowAll = computed(() => !showAll.value && events.value.length >= 20);

async function load(opts: { silent?: boolean; all?: boolean } = {}) {
	const token = gate.begin();
	if (!opts.silent) loading.value = true;
	try {
		const d = await getTeam(host.api, props.id, showAll.value || opts.all ? { events: 'all' } : undefined);
		if (!gate.isCurrent(token)) return;
		detail.value = d;
		loadError.value = '';
		if (d.team.is_member && !ownPersonId.value) void findOwnPerson();
	} catch (e: any) {
		if (!gate.isCurrent(token)) return;
		loadError.value = e?.status === 404 ? 'There is no such team.' : e?.message || 'Could not load the team.';
		if (!opts.silent) detail.value = null;
	} finally {
		if (gate.isCurrent(token)) loading.value = false;
	}
}

async function findOwnPerson() {
	const user = host.user.value?.id;
	if (!user) return;
	try {
		const res = await host.api.get('/items/people', { params: { filter: JSON.stringify({ user_id: { _eq: user } }), fields: ['person_id'], limit: 1 } });
		ownPersonId.value = res.data?.data?.[0]?.person_id ?? null;
	} catch {
		ownPersonId.value = null;
	}
}

onMounted(() => void load());
onBeforeUnmount(() => gate.cancel());
// /teams/a to /teams/b keeps this page mounted: read the other team.
watch(() => props.id, () => {
	detail.value = null;
	showAll.value = false;
	ownPersonId.value = null;
	void load();
});

async function showEverything() {
	loadingAll.value = true;
	showAll.value = true;
	await load({ silent: true, all: true });
	loadingAll.value = false;
}

async function act(work: () => Promise<unknown>, words: (e: any) => string = (e) => e?.message || 'That did not work.') {
	busy.value = true;
	actionError.value = '';
	try {
		await work();
		return true;
	} catch (e: any) {
		actionError.value = words(e);
		return false;
	} finally {
		busy.value = false;
	}
}

const isSelf = (m: TeamMember) => !!ownPersonId.value && m.person_id === ownPersonId.value;
const name = (m: TeamMember) => m.full_name || 'Unnamed person';

async function toggleManager(m: TeamMember) {
	if (await act(() => setManager(host.api, props.id, m.person_id, !m.is_manager))) await load({ silent: true });
}
async function remove(m: TeamMember) {
	if (!confirm(`Remove ${name(m)} from ${team.value?.name}? Their access through the team ends at once.`)) return;
	if (await act(() => removeMember(host.api, props.id, m.person_id))) await load({ silent: true });
}
async function leave(m: TeamMember) {
	if (!confirm(`Leave ${team.value?.name}? Your access through the team ends at once.`)) return;
	if (await act(() => removeMember(host.api, props.id, m.person_id))) host.navigate(BACK);
}
async function removeTeam() {
	const t = team.value;
	if (!t) return;
	if (!confirm(`Delete the team ${t.name}? Its access to records goes with it; the owners of those records are told.`)) return;
	if (await act(() => deleteTeam(host.api, props.id), (e) => deleteRefusal(t.name, e))) host.navigate(BACK);
}
</script>

<template>
	<ExplorerView :title="team ? team.name : 'Team'">
		<PageShell narrow>
			<nav class="d1-crumbs" aria-label="Breadcrumb">
				<AppLink to="/home">Home</AppLink><span>›</span><AppLink to="/home/people">People</AppLink><span>›</span><AppLink :to="BACK">Teams</AppLink>
			</nav>

			<v-progress-circular v-if="loading && !detail" indeterminate class="load" />
			<v-notice v-else-if="loadError && !detail" type="danger">{{ loadError }}</v-notice>
			<template v-else-if="detail && team">
				<header class="head">
					<TeamTile :team="tileOf(team)" size="lg" />
					<div class="titles">
						<h1>{{ team.name }}</h1>
						<p v-if="team.description" class="desc">{{ team.description }}</p>
						<p class="sub">{{ summary }}</p>
					</div>
					<div v-if="manage" class="head-actions">
						<v-button small secondary @click="editOpen = true"><v-icon name="edit" left small />Edit</v-button>
						<v-button small secondary :disabled="busy" @click="removeTeam"><v-icon name="delete" left small />Delete</v-button>
					</div>
				</header>
				<p v-if="actionError" class="d1-note bad" role="alert">{{ actionError }}</p>

				<Section title="Members" :count="members.length">
					<template v-if="manage" #actions>
						<v-button small @click="addOpen = true"><v-icon name="person_add" left small />Add member</v-button>
					</template>
					<ul class="members">
						<li v-for="m in members" :key="m.person_id" class="member">
							<span class="mn">{{ name(m) }}</span>
							<span v-if="m.is_manager" class="badge">manager</span>
							<span v-if="!m.can_sign_in" class="tag">no login</span>
							<span class="grow" />
							<template v-if="manage">
								<button type="button" class="link" :disabled="busy" @click="toggleManager(m)">{{ m.is_manager ? 'Remove manager' : 'Make manager' }}</button>
								<button v-if="!isSelf(m)" type="button" class="link" :disabled="busy" @click="remove(m)">Remove</button>
							</template>
							<button v-if="isSelf(m) && !canViewAllAccess" type="button" class="link" :disabled="busy" @click="leave(m)">Leave</button>
						</li>
					</ul>
					<p v-if="managersLine(team.managers) === ''" class="d1-note warn pad">This team has no manager.<template v-if="!canViewAllAccess"> An administrator can add one.</template></p>
				</Section>

				<Section title="Records" :count="recordsTotal">
					<ul class="levels" aria-label="Records by access level">
						<li v-for="l in levels" :key="l.key"><strong>{{ l.n }}</strong> {{ l.label }}</li>
					</ul>
					<ul v-if="detail.records.length" class="records">
						<li v-for="r in detail.records" :key="`${r.collection}:${r.id}`" class="rec">
							<span class="kind">{{ kindLabel(r.kind) }}</span>
							<RecordLink :collection="r.collection" :id="r.id">{{ r.code || 'No code' }}</RecordLink>
							<span class="rt">{{ r.title }}</span>
							<span class="grow" />
							<span class="role">{{ levelLabel(r.role) }}</span>
						</li>
					</ul>
					<p v-if="hidden" class="d1-note pad">{{ hidden }}</p>
					<p v-else-if="!detail.records.length" class="d1-note pad">No records are shared with this team.</p>
				</Section>

				<Section title="History" :count="events.length" :empty="!events.length" empty-text="Nothing has happened to this team yet.">
					<ul class="history">
						<li v-for="e in events" :key="e.event_id" class="ev">
							<span class="when">{{ formatDate(e.at) }}</span>
							<span>{{ historyLabel(e) }}</span>
						</li>
					</ul>
					<div v-if="canShowAll" class="pad"><button type="button" class="link" :disabled="loadingAll" @click="showEverything">Show all</button></div>
				</Section>

				<TeamEditDialog v-model="editOpen" :team="team" @saved="load({ silent: true })" @partial="load({ silent: true })" />
				<AddMemberDialog v-model="addOpen" :team="team" :member-ids="members.map((m) => m.person_id)" @added="load({ silent: true })" />
			</template>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.load { display: block; margin: 40px auto; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.titles { flex: 1 1 240px; min-width: 0; }
.titles h1 { margin: 0; font-size: var(--fs-2xl, 22px); font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
.desc { margin: 2px 0 0; color: var(--d1-dim); overflow-wrap: anywhere; }
.sub { margin: 2px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.head-actions { display: flex; gap: 8px; }
.pad { padding: 8px 14px; margin: 0; }
.grow { flex: 1; }
.members, .records, .history, .levels { list-style: none; margin: 0; padding: 0; }
.member, .rec, .ev { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; padding: 7px 14px; border-top: 1px solid var(--d1-line); }
.member:first-child, .rec:first-child, .ev:first-child { border-top: 0; }
.mn { font-weight: 600; overflow-wrap: anywhere; }
.badge { padding: 0 6px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-accent, var(--theme--primary));
	border: 1px solid color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 45%, transparent); }
.tag { font-size: var(--fs-xs, 11px); color: var(--d1-warn); }
.link { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; cursor: pointer; }
.link:disabled { opacity: .5; cursor: default; }
.levels { display: flex; flex-wrap: wrap; gap: 4px 20px; padding: 8px 14px; border-bottom: 1px solid var(--d1-line); font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.levels strong { color: var(--theme--foreground); font-variant-numeric: tabular-nums; }
.kind { font-size: var(--fs-xs, 11px); font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--d1-dim); }
.rt { color: var(--d1-dim); overflow-wrap: anywhere; }
.role { font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; }
.when { flex: 0 0 90px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); font-variant-numeric: tabular-nums; }
</style>
