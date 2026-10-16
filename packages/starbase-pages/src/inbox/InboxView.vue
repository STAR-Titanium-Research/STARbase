<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { LoadState, Section, formatDate, useExplorerHost, useInboxSummary } from '@d1/ui';
import AcceptDialog from './AcceptDialog.vue';
import AddScanDialog from './AddScanDialog.vue';
import InboxFilters from './InboxFilters.vue';
import InboxRow from './InboxRow.vue';
import InboxTabs from './InboxTabs.vue';
import LinkDialog from './LinkDialog.vue';
import type { FoundFile } from './inboxApi';
import { NO_FOLDER_TEXT, acceptButtonText, batchTitle, groupLinked, type LinkedGroup } from './inboxBulk';
import { DOCUMENT_NOTICE, EMPTY_TEXT, filtersToQuery, parseFilters, type InboxFilters as Filters } from './inboxModel';
import type { ScanAddForm } from './inboxScan';
import { createInbox, type Outcome } from './useInbox';
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

onMounted(() => {
	void inbox.load();
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

// ---- Accept all: its confirm opens on a dry run ----
const acceptable = computed(() => (tab.value === 'new' || tab.value === 'older'));
async function accept() {
	const r = await inbox.confirmAccept();
	if (r.ok) (region.value as HTMLElement | null)?.focus();
}
</script>

<template>
	<div ref="root" class="inbox">
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
			<v-button small :disabled="!canAcceptAll" data-test="accept-all" @click="inbox.openAccept()">{{ acceptButtonText(preview) }}</v-button>
			<span class="hint">Links the files whose name or folder carries the exact short ID of one record you can edit.</span>
		</div>

		<!-- One status region, always in the page, so a screen reader hears each message as it arrives. -->
		<div ref="region" class="status" role="status" aria-live="polite" tabindex="-1" data-test="status">
			<p v-if="notice" class="banner" :class="notice.tone" data-test="notice">
				<span>{{ notice.text }}</span>
				<button v-if="notice.undo" type="button" class="lf-link" :disabled="inbox.undoing.value !== null" data-test="undo" @click="inbox.undo(notice.undo)">Undo</button>
				<button type="button" class="lf-link close" @click="inbox.dismissNotice()">Close</button>
			</p>
			<p v-if="error" class="banner bad">{{ error }}</p>
		</div>

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

		<LinkDialog v-model="dialogOpen" :file="dialogFile" :busy="dialogBusy" :error="dialogError" @choose="choose" />

		<AddScanDialog v-model="scanOpen" :file="scanFile" :busy="scanBusy" :error="scanError" :error-field="scanField" @submit="addScan" />

		<AcceptDialog :dialog="inbox.acceptDialog.value" :busy="inbox.accepting.value" @confirm="accept" @cancel="inbox.closeAccept()" />
	</div>
</template>

<style scoped>
.inbox { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.lead { margin: 0; flex: 1 1 320px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); line-height: 1.5; }
.status { display: flex; flex-direction: column; gap: 8px; }
.status:empty { display: none; }
.status:focus { outline: none; }
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
