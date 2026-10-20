<script setup lang="ts">
// The People page: a sparse list (filter chips with counts, Role, Team and Sort menus, one quiet "needs attention" line) with the open person
// in a panel beside it. What the list shows (chip, role, sort, search, attention filter, open person) lives in the URL, so a link or a reload
// brings the same view back. An administrator sees logins, account roles and the attention line; a member sees names and kinds of work. A Lab
// Viewer sees what an administrator sees (everyone's panel, the Account section, the attention line) and has no control that changes anything.
// Below the wide layout (1000 px) the open person is a full-height sheet over the page, as STARbase's phone menu is; on a phone the
// header, the filters and the rows are laid out to fit 375 px.
import ExplorerView from '../ExplorerView.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { PageShell, SegmentedControl, canonicalPath, pinTargetForIndex, providePagePin, useExplorerHost } from '@d1/ui';
import PersonEditDialog from './PersonEditDialog.vue';
import InviteDialog from './InviteDialog.vue';
import LinkLoginDialog from './LinkLoginDialog.vue';
import PersonPanel from './PersonPanel.vue';
import PersonRow from './PersonRow.vue';
import { backdropDismiss, tabWrapTarget, useNarrowPanel } from './panelSheet';
import TeamsView from '../teams/TeamsView.vue';
import { loadAttention, loadPeople, type AttentionItem, type PeopleData } from './peopleApi';
import { ATTENTION_LABELS, applyList, chipCounts, groupPeople, parseListState, toQuery, type Chip, type ListState, type PeopleRow, type PeopleViewKind } from './peopleQuery';

const host = useExplorerHost();
const { api, isAdmin, canViewAllAccess } = host;
// seeAll: the administrator's reads (logins, roles, the attention line, every person's panel). readOnly: a Lab Viewer, who has those and no
// Invite, Add person, "Link to a person…" or edit; the panel and the dialogs gate their own controls the same way.
const seeAll = computed(() => isAdmin.value || canViewAllAccess.value);
const readOnly = computed(() => canViewAllAccess.value);
const route = useRoute();
const router = useRouter();
const go = (to: string) => host.navigate(to);
// The Pin button after the title, in the host frame (DESIGN.md "Pin on the title"): this page (a bespoke page, not IndexPage) provides its own target.
providePagePin(computed(() => pinTargetForIndex(canonicalPath(route.path), null)));

// ---- the list state, in the URL ----
const state = computed(() => parseListState(route.query));
function update(patch: Partial<ListState>) {
	void router.replace({ path: route.path, query: toQuery({ ...state.value, ...patch }) });
}
// People | Teams: the Teams view is the same page with ?view=teams. Each view keeps only its own query, so switching starts the other clean.
const teamsView = computed(() => state.value.view === 'teams');
const VIEWS: { value: PeopleViewKind; label: string }[] = [
	{ value: 'people', label: 'People' },
	{ value: 'teams', label: 'Teams' },
];
const setView = (v: PeopleViewKind) => void router.replace({ path: route.path, query: v === 'teams' ? { view: 'teams' } : {} });
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
	const admin = seeAll.value;
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
watch(seeAll, () => void load());

const rows = computed<PeopleRow[]>(() => data.value?.rows ?? []);
const canAdminister = computed(() => data.value?.canAdministerAccounts === true);
const roles = computed(() => (data.value?.roles ?? []).map((r) => ({ id: r.id, name: r.name ?? r.id })));
const counts = computed(() => chipCounts(rows.value));
// A member has no logins to filter by: their list state is the chip, team, sort and search only.
const effective = computed<ListState>(() => (seeAll.value ? state.value : { ...state.value, role: 'any', attn: null }));
const shown = computed(() => applyList(rows.value, effective.value));
// What is shown, in groups (Admins, Users, Operators, Former); the filters, chips and search have already chosen the rows.
const groups = computed(() => groupPeople(shown.value));

const CHIPS: { id: Chip; label: string; admin?: boolean }[] = [
	{ id: 'all', label: 'Everyone' },
	{ id: 'researchers', label: 'Researchers' },
	{ id: 'operators', label: 'Operators' },
	{ id: 'nologin', label: 'No login', admin: true },
	{ id: 'former', label: 'Former' },
];
const chips = computed(() => CHIPS.filter((c) => !c.admin || seeAll.value));

const roleItems = computed(() => [
	{ text: 'Role: Any', value: 'any' },
	...roles.value.map((r) => ({ text: `Role: ${r.name}`, value: r.id })),
	{ text: 'Role: No login', value: 'none' },
]);
// Everyone may filter by team (a Lab Member reads the teams too); the menu is left out when there are none to choose from.
const teamItems = computed(() => [
	{ text: 'Team: any', value: 'any' },
	...(data.value?.teams ?? []).map((t) => ({ text: `Team: ${t.name}`, value: t.team_id })),
]);
const showTeamMenu = computed(() => (data.value?.teams.length ?? 0) > 0 || state.value.team !== 'any');
const sortItems = computed(() => [
	{ text: 'Sort: Name', value: 'name' },
	...(seeAll.value ? [{ text: 'Sort: Last sign-in', value: 'last' }] : []),
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
	if (teamsView.value) return null;
	const id = state.value.person;
	const r = id ? rows.value.find((x) => x.person_id === id) : undefined;
	return r && (seeAll.value || isOwn(r)) ? r.person_id : null;
});
// A link to someone who is gone (or whom this user may not open) leaves no stale ?person= in the URL.
watch([panelId, data, loading], () => {
	if (state.value.person && !panelId.value && !loading.value && host.adminKnown.value && data.value?.forAdmin === seeAll.value) update({ person: null });
});
function openRow(r: PeopleRow) {
	if (r.kind !== 'person' || !r.person_id) return;
	if (seeAll.value || isOwn(r)) update({ person: r.person_id });
	else openDialog(r);
}
// Focus goes back to the row that opened the panel. Where the panel is a sheet the page behind is inert until the sheet is gone, and the
// URL (so the sheet) changes a moment after update() is called: the sheet's watcher below does it then.
let returnTo: string | null = null;
// The last person whose panel was open: where focus goes when the sheet closes by some other route (the stale-person watcher, Back).
let lastOpened: string | null = null;
const focusRow = (id: string | null) => listEl.value?.querySelector<HTMLElement>(`[data-key="${id}"]`)?.focus();
async function closePanel() {
	const id = state.value.person;
	update({ person: null });
	if (sheetOpen.value) {
		returnTo = id;
		return;
	}
	await nextTick();
	focusRow(id);
}
const onChanged = () => void load(true);

// ---- the panel as a sheet (below the wide layout) ----
const narrowPanel = useNarrowPanel();
const sheetOpen = computed(() => narrowPanel.value && !!panelId.value);
const slotEl = ref<HTMLElement | null>(null);
const panelName = computed(() => rows.value.find((r) => r.person_id === panelId.value)?.full_name ?? 'Person');
// Focus goes into the sheet when it opens (closePanel gives it back to the row). The sheet takes it itself, not a button: nothing is
// pressed by accident, and a screen reader announces the dialog and its name.
watch(panelId, (id) => {
	if (id) lastOpened = id;
}, { immediate: true });
watch(sheetOpen, async (open) => {
	await nextTick();
	if (open) {
		returnTo = null;
		slotEl.value?.focus({ preventScroll: true });
		return;
	}
	// closePanel asked for a row; any other way of closing leaves focus on <body>, so give it to the last person's row if it is still there
	const id = returnTo ?? (!document.activeElement || document.activeElement === document.body ? lastOpened : null);
	returnTo = null;
	if (id) focusRow(id);
});
// A tap on the backdrop closes the sheet: the press must have started there too (a drag out of the sheet is not a tap).
let pressedBackdrop = false;
const onBackdropDown = (e: PointerEvent) => (pressedBackdrop = e.target === e.currentTarget);
const onBackdropClick = (e: MouseEvent) => {
	const started = pressedBackdrop;
	pressedBackdrop = false;
	if (sheetOpen.value && backdropDismiss(started, e.target === e.currentTarget)) void closePanel();
};
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Tab wraps inside the sheet (the page behind is inert; this is the edge, where focus would leave for the browser's own chrome).
function onSheetTab(e: KeyboardEvent) {
	const sheet = slotEl.value;
	if (!sheetOpen.value || !sheet) return;
	const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
	const to = tabWrapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
	if (to === null) return;
	e.preventDefault();
	items[to]?.focus();
}

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

		<PageShell :narrow="!panelId || narrowPanel">
			<!-- The page behind the sheet is inert while the sheet is open (it is a modal dialog). display: contents keeps PageShell's gap. -->
			<div class="behind" :inert="sheetOpen">
			<!-- No heading of its own: the header bar already says "People". -->
			<div class="bar">
				<SegmentedControl :model-value="state.view" :options="VIEWS" label="Show" @update:model-value="setView" />
				<div class="grow" />
				<v-input v-if="!teamsView" class="search" :model-value="qText" placeholder="Search name / email…" :small="true" @update:model-value="onSearch">
					<template #prepend><v-icon name="search" small /></template>
				</v-input>
				<v-button v-if="isAdmin && !readOnly && !teamsView" class="act" small @click="inviteFor = null"><v-icon name="mail" left small />Invite</v-button>
				<v-button v-if="!teamsView && !readOnly" class="act" small :secondary="isAdmin" @click="openDialog(null)"><v-icon name="person_add" left small />Add person</v-button>
			</div>

			<template v-if="!teamsView">
			<div class="filters">
				<div class="chips">
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
				</div>
				<!-- Role, Team and Sort: after the chips, and on a phone one row of equal menus under them. -->
				<div class="menus">
					<v-select v-if="seeAll" class="menu" :model-value="state.role" :items="roleItems" @update:model-value="update({ role: String($event) })" />
					<v-select v-if="showTeamMenu" class="menu" :model-value="state.team" :items="teamItems" @update:model-value="update({ team: String($event) })" />
					<v-select class="menu" :model-value="state.sort" :items="sortItems" @update:model-value="update({ sort: $event as ListState['sort'] })" />
				</div>
			</div>

			<div v-if="seeAll && state.attn" class="attn">
				Showing {{ attentionActive }} · <button type="button" class="link" @click="pickAttention(null)">clear</button>
			</div>
			<div v-else-if="seeAll && attentionTotal" ref="attnEl" class="attn">
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
					<div v-else ref="listEl" class="groups">
						<section v-for="g in groups" :key="g.id" class="group" :aria-labelledby="`people-group-${g.id}`">
							<h2 :id="`people-group-${g.id}`" class="grp">{{ g.label }} <span class="n">{{ g.rows.length }}</span></h2>
							<div class="list">
								<PersonRow
									v-for="r in g.rows"
									:key="rowKey(r)"
									:row="r"
									:row-key="rowKey(r)"
									:admin="seeAll"
									:read-only="readOnly"
									:selected="!!panelId && r.person_id === panelId"
									@open="openRow"
									@link="openLink"
								/>
							</div>
						</section>
					</div>
				</div>
				<!-- Wide: the panel is beside the list, where it is written. Narrower: the same markup is teleported to the body as a
					sheet with a backdrop (the page is inert behind it), so the list's scroller cannot be reached through it. -->
				<Teleport to="body" :disabled="!narrowPanel">
					<div v-if="panelId" :class="narrowPanel ? 'sheet-backdrop d1-kit' : 'panel-wrap'" @pointerdown="onBackdropDown" @click="onBackdropClick">
						<aside
							ref="slotEl"
							class="panel-slot"
							:class="{ sheet: narrowPanel }"
							:role="narrowPanel ? 'dialog' : undefined"
							:aria-modal="narrowPanel ? 'true' : undefined"
							:aria-label="narrowPanel ? panelName : undefined"
							:tabindex="narrowPanel ? -1 : undefined"
							@keydown.tab="onSheetTab"
						>
							<PersonPanel
								:key="panelId"
								:person-id="panelId"
								:rows="rows"
								:can-administer-accounts="canAdminister"
								:roles="roles"
								:sheet="narrowPanel"
								@close="closePanel"
								@changed="onChanged"
								@invite="inviteFor = $event"
							/>
						</aside>
					</div>
				</Teleport>
			</div>
			</template>
			<TeamsView v-else />
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
/* Inert wrapper for the sheet; it adds no box, so PageShell's gap still spaces the blocks inside it. */
.behind { display: contents; }

.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.grow { flex: 1; }
/* A fixed basis, not only a maximum: free to shrink, the field shrank to its icon and "Se…" and the row never wrapped. */
.bar .search { flex: 0 0 220px; max-width: 100%; }

.filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
/* Wide: the chips, then Role, Team and Sort pushed to the right. The three menus are one item, so when the row is too narrow they wrap
   together onto a second line (Sort never wraps alone). */
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.menus { display: flex; gap: 6px; align-items: center; margin-left: auto; }
/* The force app's chip: 26px, a pill, filled with the accent when it is the one chosen. */
.fc { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border: 1px solid var(--d1-line); background: var(--d1-surface); border-radius: 99px;
	font: inherit; font-size: var(--fs-sm); font-weight: 600; line-height: 1; color: var(--d1-dim); cursor: pointer; }
.fc:hover { color: var(--theme--foreground); }
.fc.on { background: var(--d1-accent, var(--theme--primary, #1d4ed8)); border-color: var(--d1-accent, var(--theme--primary, #1d4ed8)); color: var(--d1-on-accent, #fff); }
.fc .n { opacity: .75; font-weight: 700; margin-left: 5px; font-variant-numeric: tabular-nums; }
/* Two classes: STARbase's v-select stand-in sets width: 100% and min-height: 36px with one, and which of the two stylesheets comes last is not ours to count on. */
.menus .menu { width: auto; min-width: 0; max-width: 138px; min-height: 28px; font-size: var(--fs-sm); }

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
.groups { display: flex; flex-direction: column; gap: 16px; }
/* A small dim heading over each group's panel, like the index pages' section labels (sentence case, not shouting). */
.grp { margin: 0 0 6px 2px; font-size: var(--fs-sm); font-weight: 600; color: var(--d1-dim); }
.grp .n { font-weight: 400; margin-left: 4px; font-variant-numeric: tabular-nums; }
.list { display: flex; flex-direction: column; background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius); box-shadow: var(--d1-shadow); overflow: hidden; }

/* Wide (1000 px and up): the panel sits beside the list. Narrower: it is a full-height sheet over the page, as the phone menu is: a
   backdrop (a tap closes it), the sheet square to the screen edges at its right, 32 px of backdrop left to tap at 375 px, safe-area insets
   respected (the panel's own header stays put, its body scrolls). The sheet is teleported to <body>, so the page's scroller cannot be
   scrolled through the backdrop; it wears d1-kit for the tokens. */
.panel-wrap { display: contents; }
.sheet-backdrop { position: fixed; inset: 0; z-index: 80; display: flex; justify-content: flex-end; background: rgba(0, 0, 0, 0.4); touch-action: none; overscroll-behavior: contain;
	color: var(--theme--foreground); font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif); font-size: var(--fs-md, 13px); line-height: 1.45; }
.panel-slot.sheet { box-sizing: border-box; width: min(440px, calc(100vw - 32px)); height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden;
	padding-right: env(safe-area-inset-right); background: var(--d1-surface); border-left: 1px solid var(--d1-line); box-shadow: -4px 0 24px rgba(0, 0, 0, 0.3); touch-action: pan-y; }
.panel-slot.sheet:focus { outline: none; }
@media (min-width: 1000px) {
	.split.open { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: start; }
	.panel-slot { position: sticky; top: 16px; }
}

/* Phone (< 768 px, spec 3.3): the header, the filters and the rows fit 375 px. */
@media (max-width: 767px) {
	/* People | Teams on the first line, the search across the next, Invite and Add person under it. */
	.bar .search { order: 3; flex: 1 1 100%; }
	.act { order: 4; }
	/* The chips wrap; Role, Team and Sort are one row of equal menus, not a full-width select each. */
	.filters { flex-direction: column; align-items: stretch; gap: 8px; }
	.menus { margin-left: 0; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 8px; }
	.menus .menu { width: 100%; min-width: 0; max-width: none; min-height: 32px; text-overflow: ellipsis; }
	.attn-menu { max-width: 100%; }
}
</style>
