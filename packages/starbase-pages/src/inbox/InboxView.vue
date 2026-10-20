<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { LoadState, Section, formatDate, openLink, useExplorerHost, useInboxSummary } from '@d1/ui';
import AcceptDialog from './AcceptDialog.vue';
import AddScanDialog from './AddScanDialog.vue';
import IgnoreFolderDialog from './IgnoreFolderDialog.vue';
import IgnoredFolders from './IgnoredFolders.vue';
import InboxFilters from './InboxFilters.vue';
import InboxRow from './InboxRow.vue';
import InboxSheet from './InboxSheet.vue';
import InboxTabs from './InboxTabs.vue';
import InboxViewRail from './InboxViewRail.vue';
import LinkDialog from './LinkDialog.vue';
import type { FoundFile } from './inboxApi';
import { NO_FOLDER_TEXT, acceptButtonText, batchTitle, groupLinked, type LinkedGroup } from './inboxBulk';
import { DOCUMENT_NOTICE, EMPTY_TEXT, IMAGE_KINDS, filtersToQuery, parseFilters, type InboxFilters as Filters } from './inboxModel';
import type { ScanAddForm } from './inboxScan';
import { createInbox, type Outcome } from './useInbox';
import { createIgnoredFolders } from './useIgnoredFolders';
import { useViewSettings } from './useViewSettings';
import { viewBoxPath } from './viewBoxModel';
import '../labels/form.css';

// The Inbox page (/inbox, spec section 10): the found files in the person's folder and their teams' folders, with tabs New, Older files,
// Recently linked and Dismissed; each row says what the crawler thinks the file is and which record it names, and why. Link, Change (a record
// picker) and Dismiss; Accept all links only the exact short-ID matches, with a confirm that shows the count and one Undo for the batch;
// Rescan my folder. Documents and other files are collapsed under "Other files". The filters and the tab live in the URL.
const host = useExplorerHost();
const route = useRoute();
const router = useRouter();
const summary = useInboxSummary(host);

const filters = computed<Filters>(() => parseFilters(route.query));
function patch(p: Partial<Filters>) {
	void router.replace({ path: route.path, query: filtersToQuery({ ...filters.value, ...p }) });
}
const clearFilters = () => patch({ kind: 'any', folder: '', from: '', to: '', owner: 'any', strength: 'any' });

const inbox = createInbox({ api: host.api, getFilters: () => filters.value, onChanged: () => void summary.refresh() });
const { main, other, loading, error, notice, preview, canAcceptAll } = inbox;
// Ignored folders (spec section 15): after a rule is added or removed the lists and the counts are read again.
const ig = createIgnoredFolders({
	api: host.api,
	say: inbox.say,
	rows: () => [...main.value.rows, ...other.value.rows],
	onChanged: async () => {
		await inbox.load();
		void summary.refresh();
	},
});

onMounted(() => {
	void inbox.load();
	void ig.load();
	void summary.refresh();
});
onBeforeUnmount(() => inbox.cancel());
// Any filter (or the tab) changing in the URL reloads both lists; a late answer to the old filters is dropped by the page's gates.
watch(() => JSON.stringify(filtersToQuery(filters.value)), () => void inbox.load());

const tab = computed(() => filters.value.tab);
const teams = computed(() => summary.summary.value?.teams ?? []);
const hasOwn = computed(() => !!summary.summary.value?.person);
const showOwner = computed(() => teams.value.length > 0);
const noFolder = computed(() => {
	const s = summary.summary.value;
	return !!s && (!s.person || !s.person.has_alias) && s.teams.length === 0;
});
const tabCount = (id: string): number | null => {
	const s = summary.summary.value;
	return s && id === 'new' ? s.newCount : s && id === 'older' ? s.olderMatches : null;
};

const groups = (rows: FoundFile[]): LinkedGroup[] => (tab.value === 'linked' ? groupLinked(rows) : [{ batch: null, rows }]);
const mainGroups = computed(() => groups(main.value.rows));
const otherGroups = computed(() => groups(other.value.rows));
const nothing = computed(() => !loading.value && !error.value && main.value.total === 0 && other.value.total === 0);

// ---- focus: after a file leaves the list the person is not left on nothing ----
// Link, Dismiss and Restore take the row away. Focus goes to the row that took its place (the next one, or the last), else to the status
// line, which says what happened. A keyboard user keeps their place; a screen reader hears the notice.
const root = ref<HTMLElement | null>(null);
const region = ref<HTMLElement | null>(null);
const rowEls = (): HTMLElement[] => [...(root.value?.querySelectorAll<HTMLElement>('[data-test="inbox-row"]') ?? [])];
async function keepPlace(f: FoundFile, work: () => Promise<Outcome>): Promise<Outcome> {
	const at = rowEls().findIndex((el) => el.dataset.rowId === f.candidate_id);
	const r = await work();
	if (!r.ok) return r;
	await nextTick();
	const rows = rowEls();
	const next = rows[Math.min(Math.max(at, 0), rows.length - 1)];
	// the row's own actions first: its thumbnail button (a row with a picture) comes before them in the page but is not what a person was doing
	const target = next?.querySelector<HTMLElement>('.buttons button:not([disabled])') ?? next?.querySelector<HTMLElement>('button:not([disabled]), a[href]') ?? region.value;
	target?.focus();
	return r;
}
const linkRow = (f: FoundFile) => keepPlace(f, () => inbox.linkSuggested(f));
const dismissRow = (f: FoundFile) => keepPlace(f, () => inbox.dismiss(f));
const restoreRow = (f: FoundFile) => keepPlace(f, () => inbox.restore(f));

// ---- the Link dialog (Change, a file with no suggestion, a document) ----
const dialogFile = ref<FoundFile | null>(null);
const dialogOpen = ref(false);
const dialogBusy = ref(false);
const dialogError = ref('');
function openDialog(f: FoundFile) {
	dialogFile.value = f;
	dialogError.value = '';
	dialogOpen.value = true;
}
async function choose(rec: { collection: string; id: string }) {
	const f = dialogFile.value;
	if (!f || dialogBusy.value) return;
	dialogBusy.value = true;
	dialogError.value = '';
	const r = await keepPlace(f, () => inbox.link(f, rec.collection, rec.id));
	dialogBusy.value = false;
	if (r.ok) dialogOpen.value = false;
	else dialogError.value = r.message;
}

// ---- the Add a surface scan dialog (a surface scan is ADDED to an insert or an edge, never linked) ----
const scanFile = ref<FoundFile | null>(null);
const scanOpen = ref(false);
const scanBusy = ref(false);
const scanError = ref('');
const scanField = ref('');
function openScan(f: FoundFile) {
	scanFile.value = f;
	scanError.value = '';
	scanField.value = '';
	scanOpen.value = true;
}
async function addScan(form: ScanAddForm) {
	const f = scanFile.value;
	if (!f || scanBusy.value) return; // a second click while the first is running does nothing
	scanBusy.value = true;
	scanError.value = '';
	scanField.value = '';
	const r = await keepPlace(f, () => inbox.addScan(f, form));
	scanBusy.value = false;
	if (r.ok) scanOpen.value = false;
	else {
		scanError.value = r.message;
		scanField.value = r.field ?? '';
	}
}

// ---- Ignore this folder: the confirm, then the rows below the folder are gone from the list ----
// Focus goes back to the row's button when the confirm is cancelled (Cancel, Esc, click outside); after a confirmed ignore the row is gone, so it goes to the
// status line, which says what happened.
let ignoreOpener: HTMLElement | null = null;
function openIgnore(f: FoundFile, opener: HTMLElement) {
	ignoreOpener = opener;
	ig.openIgnore(f);
}
async function afterIgnoreDialog(): Promise<void> {
	await nextTick();
	const back = ignoreOpener;
	ignoreOpener = null;
	const target = back?.isConnected && !back.hasAttribute('disabled') ? back : region.value;
	target?.focus();
}
function cancelIgnore() {
	// Esc makes the dialog say both "esc" and "closed": the second one finds nothing open and does nothing
	if (!ig.dialog.value.open) return;
	ig.closeIgnore();
	// a confirm that is busy (the request is running) does not close: nothing to give back yet
	if (!ig.dialog.value.open) void afterIgnoreDialog();
}
async function confirmIgnore() {
	const r = await ig.confirmIgnore();
	if (r.ok) await afterIgnoreDialog();
}
const canIgnore = computed(() => ig.available.value && !ig.loading.value && !ig.readOnly.value);

// ---- Accept all: its confirm opens on a dry run ----
const acceptable = computed(() => (tab.value === 'new' || tab.value === 'older'));
// The server has said that no file under this filter qualifies: the button would only open a confirm for zero files, so say why instead.
const nothingToAccept = computed(() => acceptable.value && !loading.value && inbox.acceptCount.value === 0);
async function accept() {
	const r = await inbox.confirmAccept();
	if (r.ok) (region.value as HTMLElement | null)?.focus();
}

// ---- the sheet: what a click on a file opens (the View rail's Preview setting), the selected row, the keys ----
const view = useViewSettings();
const selectedId = ref<string | null>(null);
const allRows = computed(() => [...main.value.rows, ...other.value.rows]);
const selected = computed(() => (selectedId.value ? allRows.value.find((f) => f.candidate_id === selectedId.value) ?? null : null));
// A file that leaves the list (linked, dismissed, ignored) hands the selection to its neighbour (the next row still there, else the one before), or clears it
// when none is left, so the sheet and the arrow / Enter keys keep working.
watch(allRows, (now, before) => {
	const id = selectedId.value;
	if (!id || now.some((f) => f.candidate_id === id)) return;
	const here = new Set(now.map((f) => f.candidate_id));
	const at = before.findIndex((f) => f.candidate_id === id);
	const after = at < 0 ? [] : before.slice(at + 1).filter((f) => here.has(f.candidate_id));
	const earlier = at < 0 ? [] : before.slice(0, at).filter((f) => here.has(f.candidate_id));
	selectedId.value = (after[0] ?? earlier[earlier.length - 1])?.candidate_id ?? null;
});
const sheetOn = computed(() => view.settings.preview === 'sheet');
function select(f: FoundFile) {
	selectedId.value = f.candidate_id;
	// bring the sheet into view (it is a block under the list on a narrow page)
	void nextTick(() => {
		root.value?.querySelector<HTMLElement>('[data-test="inbox-sheet"]')?.scrollIntoView?.({ block: 'nearest' });
	});
}
const nameButton = (id: string) => root.value?.querySelector<HTMLElement>(`[data-row-id="${id}"] [data-test="row-name"]`) ?? null;
async function closeSheet() {
	const id = selectedId.value;
	selectedId.value = null;
	await nextTick();
	// the keyboard user keeps their place: focus goes back to the row that was open
	if (id) (nameButton(id) ?? root.value?.querySelector<HTMLElement>(`[data-row-id="${id}"] button[data-test="thumb"]`))?.focus();
}
// Preview changed to View box while a sheet is open: the sheet goes away.
watch(sheetOn, (on) => {
	if (!on) selectedId.value = null;
});

// ---- Compare: with "Compare two files" on, pictures can be ticked (at most two); opening one of a ticked pair opens the pair side by side ----
// The ticks are this visit's own: not kept, not in the address. A file that leaves the list, or turning the option off, drops its tick.
const compareOn = computed(() => view.settings.compareList);
const ticked = ref<string[]>([]);
const canTick = (f: FoundFile) => compareOn.value && IMAGE_KINDS.includes(f.kind);
function tick(f: FoundFile, on: boolean) {
	const id = f.candidate_id;
	if (!on) ticked.value = ticked.value.filter((t) => t !== id);
	else if (!ticked.value.includes(id) && ticked.value.length < 2) ticked.value = [...ticked.value, id];
}
watch([allRows, compareOn], () => {
	const here = new Set(allRows.value.map((f) => f.candidate_id));
	const keep = compareOn.value ? ticked.value.filter((id) => here.has(id)) : [];
	if (keep.length !== ticked.value.length) ticked.value = keep;
});
/** The other file of a ticked pair, when `id` is one of the two. */
const partnerOf = (id: string): string | null => (compareOn.value && ticked.value.length === 2 && ticked.value.includes(id) ? ticked.value.find((t) => t !== id) ?? null : null);
const compareNote = computed(() => (ticked.value.length === 2 ? 'Two files ticked.' : ticked.value.length === 1 ? '1 of 2 files ticked.' : 'Tick two pictures to compare them.'));

// The view box: the file's own page (/inbox/file/<id>), carrying the filters so its previous / next and Close stay in this list, and the compare partner when the file is one of a ticked pair.
const openBox = (f: FoundFile) => openLink(viewBoxPath(f.candidate_id, filters.value, partnerOf(f.candidate_id)), router);
const openPair = () => ticked.value.length === 2 && openLink(viewBoxPath(ticked.value[0], filters.value, ticked.value[1]), router);

const anyDialogOpen = () => dialogOpen.value || scanOpen.value || ig.dialog.value.open || inbox.acceptDialog.value.open;
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="radio"], [role="dialog"]';
function onKey(e: KeyboardEvent) {
	if (!selectedId.value || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	if (e.key !== 'Escape' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
	if (anyDialogOpen()) return;
	const t = e.target instanceof Element ? e.target : null;
	if (e.key === 'Escape') {
		if (t?.closest('input, textarea, select, [role="dialog"]')) return;
		e.preventDefault();
		void closeSheet();
		return;
	}
	if (e.key === 'Enter') {
		// Enter opens the selected file's page, but never takes the key from a control: a button or link answers Enter itself, except the selected row's own name and picture.
		const own = t?.closest<HTMLElement>('[data-test="row-name"], [data-test="thumb"]');
		const mine = own?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId === selectedId.value;
		if (t?.closest(`${TYPING}, button, a[href], summary`) && !mine) return;
		if (!selected.value) return;
		e.preventDefault();
		openBox(selected.value);
		return;
	}
	if (t?.closest(TYPING)) return;
	const ids = rowEls().map((el) => el.dataset.rowId ?? '');
	const at = ids.indexOf(selectedId.value);
	const to = at < 0 ? -1 : at + (e.key === 'ArrowDown' ? 1 : -1);
	if (to < 0 || to >= ids.length) return;
	e.preventDefault();
	selectedId.value = ids[to];
	rowEls()[to]?.scrollIntoView?.({ block: 'nearest' });
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
	<div ref="root" class="frame">
	<div class="inbox">
		<div class="head">
			<p class="lead">
				<template v-if="noFolder">{{ NO_FOLDER_TEXT }}</template>
				<template v-else>Files saved in your folder on the share (and your teams' folders) that nobody has linked yet. Nothing on the share is ever changed.</template>
			</p>
			<v-button small secondary :loading="inbox.rescanning.value" data-test="rescan" @click="inbox.rescanNow()">
				<v-icon name="refresh" small left />Rescan my folder
			</v-button>
		</div>

		<InboxTabs :filters="filters" :counts="tabCount" />

		<InboxFilters :filters="filters" :teams="teams" :has-own="hasOwn" @patch="patch" @clear="clearFilters" />

		<div v-if="acceptable" class="accept">
			<template v-if="nothingToAccept">
				<span class="hint" data-test="accept-none">None of these files can be linked in bulk. Use “Link to…” on a file to link it yourself.</span>
			</template>
			<template v-else>
				<v-button small :disabled="!canAcceptAll" data-test="accept-all" @click="inbox.openAccept()">{{ acceptButtonText(preview) }}</v-button>
				<span class="hint">Links the files whose name or folder carries the exact short ID of one record you can edit.</span>
			</template>
		</div>

		<IgnoredFolders
			v-if="ig.available.value"
			:rules="ig.rules.value"
			:open="ig.open.value"
			:loading="ig.loading.value"
			:error="ig.error.value"
			:read-only="ig.readOnly.value"
			:removing="ig.removing.value"
			:adding="ig.adding.value"
			:rows="[...main.rows, ...other.rows]"
			:teams="teams"
			:has-own="hasOwn"
			:add="ig.add"
			@toggle="ig.open.value = $event"
			@remove="ig.remove($event)"
		/>

		<!-- One status region, always in the page, so a screen reader hears each message as it arrives. -->
		<div ref="region" class="status" role="status" aria-live="polite" tabindex="-1" data-test="status">
			<p v-if="notice" class="banner" :class="notice.tone" data-test="notice">
				<span>{{ notice.text }}</span>
				<button v-if="notice.undo" type="button" class="lf-link" :disabled="inbox.undoing.value !== null" data-test="undo" @click="inbox.undo(notice.undo)">Undo</button>
				<button v-if="notice.removeRule" type="button" class="lf-link" :disabled="ig.removing.value !== null" data-test="remove-rule" @click="ig.removeById(notice.removeRule)">Remove rule</button>
				<button type="button" class="lf-link close" @click="inbox.dismissNotice()">Close</button>
			</p>
			<p v-if="error" class="banner bad">{{ error }}</p>
		</div>

		<div v-if="compareOn" class="cmpbar" data-test="compare-bar">
			<span class="hint" data-test="compare-note">{{ compareNote }}</span>
			<v-button small :disabled="ticked.length !== 2" data-test="compare-open" @click="openPair()">Compare them</v-button>
			<button v-if="ticked.length" type="button" class="lf-link" data-test="compare-clear" @click="ticked = []">Clear the ticks</button>
		</div>

		<div class="work">
		<div class="listcol">
		<LoadState v-if="loading && !main.rows.length" loading loading-text="Loading your Inbox…" />
		<p v-else-if="nothing" class="d1-note" data-test="empty">{{ EMPTY_TEXT[tab] }}</p>

		<template v-for="g in mainGroups" :key="g.batch?.id ?? 'rows'">
			<div v-if="g.batch" class="batch" data-test="batch">
				<strong>{{ batchTitle(g.batch) }}</strong>
				<span v-if="g.batch.at" class="when">{{ formatDate(g.batch.at) }}</span>
				<v-button x-small secondary :disabled="inbox.undoing.value !== null" data-test="undo-batch" @click="inbox.undo({ kind: 'batch', id: g.batch.id })">Undo</v-button>
			</div>
			<ul v-if="g.rows.length" class="rows" data-test="rows">
				<InboxRow
					v-for="f in g.rows"
					:key="f.candidate_id"
					:file="f"
					:tab="tab"
					:busy="inbox.isBusy(f.candidate_id)"
					:show-owner="showOwner"
					:can-ignore="canIgnore"
					:preview="view.settings.preview"
					:selected="selectedId === f.candidate_id"
					:comparable="canTick(f)"
					:ticked="ticked.includes(f.candidate_id)"
					:tick-full="ticked.length >= 2"
					@select="select(f)"
					@open="openBox(f)"
					@tick="tick(f, $event)"
					@ignore="openIgnore(f, $event)"
					@link="linkRow(f)"
					@pick="openDialog(f)"
					@scan="openScan(f)"
					@change="openDialog(f)"
					@dismiss="dismissRow(f)"
					@restore="restoreRow(f)"
				/>
			</ul>
		</template>
		<button v-if="main.rows.length < main.total" type="button" class="lf-btn more" :disabled="inbox.moreLoading.value" @click="inbox.loadMoreMain()">
			Show more ({{ main.total - main.rows.length }} left)
		</button>

		<Section v-if="other.total > 0 || inbox.otherOpen.value" title="Other files" :count="other.total" class="other" data-test="other-files">
			<template #actions>
				<button type="button" class="lf-link" data-test="toggle-other" :aria-expanded="inbox.otherOpen.value" @click="inbox.toggleOther(!inbox.otherOpen.value)">{{ inbox.otherOpen.value ? 'Hide' : 'Show' }}</button>
			</template>
			<p class="d1-note">Documents and other files are listed by name, size and date only. {{ DOCUMENT_NOTICE }}</p>
			<LoadState v-if="inbox.otherOpen.value" :loading="inbox.otherLoading.value && !other.rows.length" :error="inbox.otherError.value" loading-text="Loading…">
				<template v-for="g in otherGroups" :key="g.batch?.id ?? 'other-rows'">
					<div v-if="g.batch" class="batch">
						<strong>{{ batchTitle(g.batch) }}</strong>
						<v-button x-small secondary :disabled="inbox.undoing.value !== null" @click="inbox.undo({ kind: 'batch', id: g.batch.id })">Undo</v-button>
					</div>
					<ul class="rows">
						<InboxRow
							v-for="f in g.rows"
							:key="f.candidate_id"
							:file="f"
							:tab="tab"
							:busy="inbox.isBusy(f.candidate_id)"
							:show-owner="showOwner"
							:can-ignore="canIgnore"
							:preview="view.settings.preview"
							:selected="selectedId === f.candidate_id"
							:comparable="canTick(f)"
							:ticked="ticked.includes(f.candidate_id)"
							:tick-full="ticked.length >= 2"
							@select="select(f)"
							@open="openBox(f)"
							@tick="tick(f, $event)"
							@ignore="openIgnore(f, $event)"
							@link="linkRow(f)"
							@pick="openDialog(f)"
							@scan="openScan(f)"
							@change="openDialog(f)"
							@dismiss="dismissRow(f)"
							@restore="restoreRow(f)"
						/>
					</ul>
				</template>
				<button v-if="other.rows.length < other.total" type="button" class="lf-btn more" @click="inbox.loadMoreOther()">Show more ({{ other.total - other.rows.length }} left)</button>
			</LoadState>
		</Section>
		</div>

		<InboxSheet
			v-if="selected && sheetOn"
			:key="selected.candidate_id"
			:file="selected"
			:tab="tab"
			:show-owner="showOwner"
			:busy="inbox.isBusy(selected.candidate_id)"
			@close="closeSheet()"
			@link="openDialog(selected)"
			@dismiss="dismissRow(selected)"
			@restore="restoreRow(selected)"
			@open-box="openBox(selected)"
		/>
		</div>

		<LinkDialog v-model="dialogOpen" :file="dialogFile" :busy="dialogBusy" :error="dialogError" @choose="choose" />

		<AddScanDialog v-model="scanOpen" :file="scanFile" :busy="scanBusy" :error="scanError" :error-field="scanField" @submit="addScan" />

		<IgnoreFolderDialog :dialog="ig.dialog.value" @confirm="confirmIgnore" @cancel="cancelIgnore" />

		<AcceptDialog :dialog="inbox.acceptDialog.value" :busy="inbox.accepting.value" @confirm="accept" @cancel="inbox.closeAccept()" />
	</div>
	<InboxViewRail
		:preview="view.settings.preview"
		:compare="view.settings.compareList"
		:open="view.settings.railOpen"
		@update:preview="view.set({ preview: $event })"
		@update:compare="view.set({ compareList: $event })"
		@update:open="view.set({ railOpen: $event })"
	/>
	</div>
</template>

<style scoped>
.frame { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; min-width: 0; container: inbox-frame / inline-size; }
.inbox { flex: 1 1 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.work { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
.listcol { flex: 1 1 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
/* Narrow pages: the View rail goes above the list (its own CSS, which gives it the full width and order -1), and under 700px the sheet is a block under the list. */
@container inbox-frame (max-width: 700px) { .work { flex-direction: column; align-items: stretch; } }
.head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.lead { margin: 0; flex: 1 1 320px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); line-height: 1.5; }
.status { display: flex; flex-direction: column; gap: 8px; }
.status:empty { display: none; }
.status:focus { outline: none; }
.cmpbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.accept { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.hint { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.banner {
	display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 8px 14px; border-radius: 10px; font-size: var(--fs-md, 13px);
	border: 1px solid color-mix(in srgb, var(--banner-ink) 40%, transparent); background: color-mix(in srgb, var(--banner-ink) 12%, transparent); color: var(--theme--foreground);
	--banner-ink: var(--d1-ok);
}
.banner.warn { --banner-ink: var(--d1-warn); }
.banner.bad { --banner-ink: var(--d1-bad); }
.banner .close { margin-left: auto; color: var(--d1-dim); font-weight: 400; }
.rows { margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.batch { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: var(--fs-md, 13px); }
.batch .when { color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
.more { align-self: flex-start; }
.other .rows { margin-top: 8px; }
</style>
