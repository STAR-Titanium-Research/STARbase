<script setup lang="ts">
// The People page: a sparse list (filter chips with counts, Role and Sort menus, one quiet "needs attention" line) with the open person
// in a panel beside it. What the list shows (chip, role, sort, search, attention filter, open person) lives in the URL, so a link or a reload
// brings the same view back. An administrator sees logins, account roles and the attention line; a member sees names and kinds of work.
import ExplorerView from '../ExplorerView.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { PageShell, PinToggle, canonicalPath, pinTargetForIndex, useExplorerHost } from '@d1/ui';
import PersonEditDialog from './PersonEditDialog.vue';
import InviteDialog from './InviteDialog.vue';
import LinkLoginDialog from './LinkLoginDialog.vue';
import PersonPanel from './PersonPanel.vue';
import PersonRow from './PersonRow.vue';
import { loadAttention, loadPeople, type AttentionItem, type PeopleData } from './peopleApi';
import { ATTENTION_LABELS, applyList, chipCounts, parseListState, toQuery, type Chip, type ListState, type PeopleRow } from './peopleQuery';

const host = useExplorerHost();
const { api, isAdmin } = host;
const route = useRoute();
const router = useRouter();
const go = (to: string) => host.navigate(to);
// The header's Pin toggle: this page (a bespoke page, not IndexPage, so it asks for its own).
const pinTarget = computed(() => pinTargetForIndex(canonicalPath(route.path), null));

// ---- the list state, in the URL ----
const state = computed(() => parseListState(route.query));
function update(patch: Partial<ListState>) {
	void router.replace({ path: route.path, query: toQuery({ ...state.value, ...patch }) });
}
// The search box keeps its own text (the URL follows it) so typing is never undone by a navigation still on its way. The finder sends
// a People hit to /home/people?q=<name>: the box follows the URL if it changes while the page stays open.
const qText = ref(state.value.q);
watch(() => state.value.q, (q) => (qText.value = q));
const onSearch = (v: unknown) => {
	qText.value = typeof v === 'string' ? v : '';
	update({ q: qText.value });
};

// ---- the data ----
const data = ref<(PeopleData & { forAdmin: boolean }) | null>(null);
const attention = ref<AttentionItem[]>([]);
const loading = ref(true);
const loadError = ref('');
let seq = 0;
async function load(silent = false) {
	const mine = ++seq;
	const admin = isAdmin.value;
	if (!silent) loading.value = true;
	try {
		const [people, attn] = await Promise.all([loadPeople(api, admin), admin ? loadAttention(api).catch((): AttentionItem[] => []) : Promise.resolve([] as AttentionItem[])]);
		if (mine !== seq) return;
		data.value = { ...people, forAdmin: admin };
		attention.value = attn;
		loadError.value = '';
	} catch (e: any) {
		if (mine !== seq) return;
		loadError.value = e?.message || 'Could not load people.';
	} finally {
		if (mine === seq) loading.value = false;
	}
}
onMounted(() => void load());
// isAdmin starts as a guess and is corrected when the server answers: load again as the right kind of user.
watch(isAdmin, () => void load());

const rows = computed<PeopleRow[]>(() => data.value?.rows ?? []);
const canAdminister = computed(() => data.value?.canAdministerAccounts === true);
const roles = computed(() => (data.value?.roles ?? []).map((r) => ({ id: r.id, name: r.name ?? r.id })));
const counts = computed(() => chipCounts(rows.value));
// A member has no logins to filter by: their list state is the chip, sort and search only.
const effective = computed<ListState>(() => (isAdmin.value ? state.value : { ...state.value, role: 'any', attn: null }));
const shown = computed(() => applyList(rows.value, effective.value));

const CHIPS: { id: Chip; label: string; admin?: boolean }[] = [
	{ id: 'all', label: 'Everyone' },
	{ id: 'researchers', label: 'Researchers' },
	{ id: 'operators', label: 'Operators' },
	{ id: 'nologin', label: 'No login', admin: true },
	{ id: 'former', label: 'Former' },
];
const chips = computed(() => CHIPS.filter((c) => !c.admin || isAdmin.value));

const roleItems = computed(() => [
	{ text: 'Role: Any', value: 'any' },
	...roles.value.map((r) => ({ text: `Role: ${r.name}`, value: r.id })),
	{ text: 'Role: No login', value: 'none' },
]);
const sortItems = computed(() => [
	{ text: 'Sort: Name', value: 'name' },
	...(isAdmin.value ? [{ text: 'Sort: Last sign-in', value: 'last' }] : []),
	{ text: 'Sort: Recently added', value: 'added' },
]);

// ---- the attention line (administrators) ----
const attentionTotal = computed(() => attention.value.reduce((n, a) => n + a.count, 0));
const attentionOpen = ref(false);
const attnEl = ref<HTMLElement | null>(null);
const reviewBtn = ref<HTMLButtonElement | null>(null);
// The hand-built menu closes on Esc (the key is taken, so the open person's panel does not also close) and on a click away from it.
const onMenuKey = (e: KeyboardEvent) => {
	if (e.key !== 'Escape') return;
	e.preventDefault();
	attentionOpen.value = false;
	void nextTick(() => reviewBtn.value?.focus());
};
const onMenuAway = (e: MouseEvent) => {
	if (attnEl.value && !attnEl.value.contains(e.target as Node)) attentionOpen.value = false;
};
// On document, so the Esc handler runs before the panel's window listener.
watch(attentionOpen, (open) => {
	if (open) {
		document.addEventListener('keydown', onMenuKey);
		document.addEventListener('click', onMenuAway);
	} else {
		document.removeEventListener('keydown', onMenuKey);
		document.removeEventListener('click', onMenuAway);
	}
});
onBeforeUnmount(() => {
	document.removeEventListener('keydown', onMenuKey);
	document.removeEventListener('click', onMenuAway);
});
const attentionItems = computed(() =>
	attention.value.map((a) => ({ key: a.key, text: ATTENTION_LABELS[a.key]?.(a.count) ?? `${a.count} ${a.key}` })),
);
const attentionActive = computed(() => attentionItems.value.find((a) => a.key === state.value.attn)?.text ?? state.value.attn);
function pickAttention(key: string | null) {
	attentionOpen.value = false;
	update({ attn: key });
}

// ---- the open person ----
const listEl = ref<HTMLElement | null>(null);
const rowKey = (r: PeopleRow) => r.person_id ?? `login:${r.user_id}`;
const isOwn = (r: PeopleRow) => !!r.user_id && r.user_id === host.user.value?.id;
// An administrator opens anyone; a member only their own row (the server shows the rest read-only).
const panelId = computed(() => {
	const id = state.value.person;
	const r = id ? rows.value.find((x) => x.person_id === id) : undefined;
	return r && (isAdmin.value || isOwn(r)) ? r.person_id : null;
});
// A link to someone who is gone (or whom this user may not open) leaves no stale ?person= in the URL.
watch([panelId, data, loading], () => {
	if (state.value.person && !panelId.value && !loading.value && host.adminKnown.value && data.value?.forAdmin === isAdmin.value) update({ person: null });
});
function openRow(r: PeopleRow) {
	if (r.kind !== 'person' || !r.person_id) return;
	if (isAdmin.value || isOwn(r)) update({ person: r.person_id });
	else openDialog(r);
}
async function closePanel() {
	const id = state.value.person;
	update({ person: null });
	await nextTick();
	listEl.value?.querySelector<HTMLElement>(`[data-key="${id}"]`)?.focus();
}
const onChanged = () => void load(true);

// The invite dialog: null = invite from the header, a row = invite that person, undefined = closed.
const inviteFor = ref<PeopleRow | null | undefined>(undefined);
// The dialog stays open to say the invite was sent (or could not be e-mailed); the list reloads at once so the row shows the new login.
function openExisting(personId: string) {
	update({ person: personId });
}

// ---- the add / read-only dialog, and the "link to a person" dialog ----
const dialogOpen = ref(false);
const dialogPerson = ref<PeopleRow | null>(null);
function openDialog(r: PeopleRow | null) {
	dialogPerson.value = r;
	dialogOpen.value = true;
}
const linkOpen = ref(false);
const linkLogin = ref<PeopleRow | null>(null);
function openLink(r: PeopleRow) {
	linkLogin.value = r;
	linkOpen.value = true;
}
</script>

<template>
	<ExplorerView title="People">
		<template #headline><span class="crumb" @click="go('/home')">Home</span></template>
		<template #title-outer:prepend>
			<v-button class="header-icon" rounded icon secondary disabled><v-icon name="groups" /></v-button>
		</template>

		<PageShell :narrow="!panelId">
			<!-- No heading of its own: the header bar already says "People". -->
			<div class="bar">
				<div class="grow" />
				<v-input class="search" :model-value="qText" placeholder="Search name / email…" :small="true" @update:model-value="onSearch">
					<template #prepend><v-icon name="search" small /></template>
				</v-input>
				<PinToggle v-if="pinTarget" :target="pinTarget" label="People" />
				<v-button v-if="isAdmin" small @click="inviteFor = null"><v-icon name="mail" left small />Invite</v-button>
				<v-button small :secondary="isAdmin" @click="openDialog(null)"><v-icon name="person_add" left small />Add person</v-button>
			</div>

			<div class="filters">
				<button
					v-for="c in chips"
					:key="c.id"
					type="button"
					class="fc"
					:class="{ on: state.chip === c.id }"
					:aria-pressed="state.chip === c.id"
					@click="update({ chip: c.id })"
				>
					{{ c.label }} <span class="n">{{ counts[c.id] }}</span>
				</button>
				<span class="sep" />
				<v-select v-if="isAdmin" class="menu" :model-value="state.role" :items="roleItems" @update:model-value="update({ role: String($event) })" />
				<v-select class="menu" :model-value="state.sort" :items="sortItems" @update:model-value="update({ sort: $event as ListState['sort'] })" />
			</div>

			<div v-if="isAdmin && state.attn" class="attn">
				Showing {{ attentionActive }} · <button type="button" class="link" @click="pickAttention(null)">clear</button>
			</div>
			<div v-else-if="isAdmin && attentionTotal" ref="attnEl" class="attn">
				{{ attentionTotal }} {{ attentionTotal === 1 ? 'thing needs' : 'things need' }} attention ·
				<button ref="reviewBtn" type="button" class="link" :aria-expanded="attentionOpen" @click="attentionOpen = !attentionOpen">review</button>
				<ul v-if="attentionOpen" class="attn-menu" data-open-menu>
					<li v-for="a in attentionItems" :key="a.key"><button type="button" class="link" @click="pickAttention(a.key)">{{ a.text }}</button></li>
				</ul>
			</div>

			<v-progress-circular v-if="loading && !data" indeterminate class="load" />
			<v-notice v-else-if="loadError && !data" type="danger">{{ loadError }}</v-notice>
			<div v-else class="split" :class="{ open: !!panelId }">
				<div class="main">
					<div v-if="!shown.length" class="empty">No people match.</div>
					<div v-else ref="listEl" class="list">
						<PersonRow
							v-for="r in shown"
							:key="rowKey(r)"
							:row="r"
							:row-key="rowKey(r)"
							:admin="isAdmin"
							:selected="!!panelId && r.person_id === panelId"
							@open="openRow"
							@link="openLink"
						/>
					</div>
				</div>
				<aside v-if="panelId" class="panel-slot">
					<PersonPanel
						:person-id="panelId"
						:rows="rows"
						:can-administer-accounts="canAdminister"
						:roles="roles"
						@close="closePanel"
						@changed="onChanged"
						@invite="inviteFor = $event"
					/>
				</aside>
			</div>
		</PageShell>

		<PersonEditDialog v-model="dialogOpen" :person="dialogPerson" @saved="load(true)" />
		<InviteDialog
			:model-value="inviteFor !== undefined"
			:person="inviteFor"
			:roles="roles"
			:can-administer-accounts="canAdminister"
			:rows="rows"
			@update:model-value="inviteFor = undefined"
			@invited="load(true)"
			@open-person="openExisting"
		/>
		<LinkLoginDialog v-model="linkOpen" :login="linkLogin" :rows="rows" @linked="load(true)" />
	</ExplorerView>
</template>

<style scoped>
.crumb { cursor: pointer; }

.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.grow { flex: 1; }
/* A fixed basis, not only a maximum: free to shrink, the field shrank to its icon and "Se…" and the row never wrapped. */
.search { flex: 0 0 220px; max-width: 100%; }

.filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
/* The force app's chip: 26px, a pill, filled with the accent when it is the one chosen. */
.fc { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--d1-line); background: var(--d1-surface); border-radius: 99px;
	font: inherit; font-size: var(--fs-sm); font-weight: 600; line-height: 1; color: var(--d1-dim); cursor: pointer; }
.fc:hover { color: var(--theme--foreground); }
.fc.on { background: var(--d1-accent, var(--theme--primary, #1d4ed8)); border-color: var(--d1-accent, var(--theme--primary, #1d4ed8)); color: var(--d1-on-accent, #fff); }
.fc .n { opacity: .75; font-weight: 700; margin-left: 5px; font-variant-numeric: tabular-nums; }
.sep { flex: 1 1 12px; }
.menu { width: auto; min-width: 0; min-height: 28px; font-size: var(--fs-sm); }

/* One quiet line, not a banner. */
.attn { margin: 0; font-size: var(--fs-sm); color: var(--d1-warn); }
.attn .link { border: 0; background: transparent; padding: 0; font: inherit; font-weight: 600; color: inherit; text-decoration: underline; cursor: pointer; }
.attn-menu { list-style: none; margin: 6px 0 0; padding: 4px 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: max-content; max-width: 100%;
	background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius); box-shadow: var(--d1-shadow); }
.attn-menu .link { display: block; padding: 4px 12px; text-align: left; }

.load, .empty { display: block; margin: 40px auto; text-align: center; color: var(--d1-dim); }

/* One panel with a row per person, not a card per person: 40 cards were 40 boxes to read past. */
.split { display: block; }
.main { min-width: 0; }
.list { display: flex; flex-direction: column; background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius); box-shadow: var(--d1-shadow); overflow: hidden; }

/* Wide: the panel sits beside the list. Narrow: it is a sheet over the bottom of the screen. */
.panel-slot { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; max-height: 70vh; overflow: auto; padding: 0 8px 8px; }
@media (min-width: 1000px) {
	.split.open { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: start; }
	.panel-slot { position: sticky; top: 16px; z-index: auto; max-height: none; overflow: visible; padding: 0; }
}
</style>
