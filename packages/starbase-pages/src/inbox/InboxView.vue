<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { LoadState, Section, formatDate, useExplorerHost, useInboxSummary } from '@d1/ui';
import InboxFilters from './InboxFilters.vue';
import InboxRow from './InboxRow.vue';
import LinkDialog from './LinkDialog.vue';
import type { FoundFile } from './inboxApi';
import { NO_FOLDER_TEXT, acceptButtonText, acceptConfirmText, batchTitle, groupLinked, type LinkedGroup } from './inboxBulk';
import { DOCUMENT_NOTICE, EMPTY_TEXT, TABS, filtersToQuery, parseFilters, type InboxFilters as Filters } from './inboxModel';
import { createInbox } from './useInbox';
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
	if (!f) return;
	dialogBusy.value = true;
	dialogError.value = '';
	const r = await inbox.link(f, rec.collection, rec.id);
	dialogBusy.value = false;
	if (r.ok) dialogOpen.value = false;
	else dialogError.value = r.message;
}

// ---- Accept all ----
const confirmOpen = ref(false);
async function accept() {
	confirmOpen.value = false;
	await inbox.acceptAllNow();
}
const acceptable = computed(() => (tab.value === 'new' || tab.value === 'older'));
</script>

<template>
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

		<div class="tabs" role="tablist" aria-label="Inbox">
			<button
				v-for="t in TABS"
				:key="t.id"
				type="button"
				role="tab"
				class="tab"
				:class="{ on: tab === t.id }"
				:aria-selected="tab === t.id"
				:data-test="`tab-${t.id}`"
				@click="patch({ tab: t.id })"
			>
				{{ t.label }}<span v-if="tabCount(t.id)" class="n">{{ tabCount(t.id) }}</span>
			</button>
		</div>

		<InboxFilters :filters="filters" :teams="teams" :has-own="hasOwn" @patch="patch" @clear="clearFilters" />

		<div v-if="acceptable" class="accept">
			<v-button small :disabled="!canAcceptAll" data-test="accept-all" @click="confirmOpen = true">{{ acceptButtonText(preview) }}</v-button>
			<span class="hint">Links the files whose name or folder carries the exact short ID of one record you can edit.</span>
		</div>

		<p v-if="notice" class="banner" :class="notice.tone" :role="notice.tone === 'ok' ? 'status' : 'alert'" data-test="notice">
			<span>{{ notice.text }}</span>
			<button v-if="notice.undo" type="button" class="lf-link" data-test="undo" @click="inbox.undo(notice.undo)">Undo</button>
			<button type="button" class="lf-link close" aria-label="Dismiss this message" @click="inbox.dismissNotice()">Close</button>
		</p>
		<p v-if="error" class="banner bad" role="alert">{{ error }}</p>

		<LoadState v-if="loading && !main.rows.length" loading loading-text="Loading your Inbox…" />
		<p v-else-if="nothing" class="d1-note" data-test="empty">{{ EMPTY_TEXT[tab] }}</p>

		<template v-for="g in mainGroups" :key="g.batch?.id ?? 'rows'">
			<div v-if="g.batch" class="batch" data-test="batch">
				<strong>{{ batchTitle(g.batch) }}</strong>
				<span v-if="g.batch.at" class="when">{{ formatDate(g.batch.at) }}</span>
				<v-button x-small secondary data-test="undo-batch" @click="inbox.undo({ kind: 'batch', id: g.batch.id })">Undo</v-button>
			</div>
			<ul v-if="g.rows.length" class="rows" data-test="rows">
				<InboxRow
					v-for="f in g.rows"
					:key="f.candidate_id"
					:file="f"
					:tab="tab"
					:busy="inbox.isBusy(f.candidate_id)"
					:show-owner="showOwner"
					@link="inbox.linkSuggested(f)"
					@pick="openDialog(f)"
					@change="openDialog(f)"
					@dismiss="inbox.dismiss(f)"
					@restore="inbox.restore(f)"
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
						<v-button x-small secondary @click="inbox.undo({ kind: 'batch', id: g.batch.id })">Undo</v-button>
					</div>
					<ul class="rows">
						<InboxRow
							v-for="f in g.rows"
							:key="f.candidate_id"
							:file="f"
							:tab="tab"
							:busy="inbox.isBusy(f.candidate_id)"
							:show-owner="showOwner"
							@link="inbox.linkSuggested(f)"
							@pick="openDialog(f)"
							@change="openDialog(f)"
							@dismiss="inbox.dismiss(f)"
							@restore="inbox.restore(f)"
						/>
					</ul>
				</template>
				<button v-if="other.rows.length < other.total" type="button" class="lf-btn more" @click="inbox.loadMoreOther()">Show more ({{ other.total - other.rows.length }} left)</button>
			</LoadState>
		</Section>

		<LinkDialog v-model="dialogOpen" :file="dialogFile" :busy="dialogBusy" :error="dialogError" @choose="choose" />

		<v-dialog v-model="confirmOpen" @esc="confirmOpen = false">
			<v-card class="confirm">
				<v-card-title>Accept all</v-card-title>
				<v-card-text><p data-test="accept-confirm">{{ acceptConfirmText(preview) }}</p></v-card-text>
				<v-card-actions>
					<div class="spacer" />
					<v-button secondary @click="confirmOpen = false">Cancel</v-button>
					<v-button data-test="accept-confirm-button" @click="accept">Link {{ preview.count }} found file{{ preview.count === 1 ? '' : 's' }}</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<style scoped>
.inbox { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.lead { margin: 0; flex: 1 1 320px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); line-height: 1.5; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--d1-line); }
.tab {
	display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px;
	background: none; color: var(--d1-dim); font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.tab:hover { color: var(--theme--foreground); }
.tab.on { color: var(--theme--foreground); border-bottom-color: var(--d1-accent, var(--theme--primary)); }
.tab:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.n { padding: 0 6px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 700; background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 16%, transparent); color: var(--d1-accent, var(--theme--primary)); }
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
.confirm { width: min(520px, calc(100vw - 24px)); }
.spacer { flex: 1; }
</style>
