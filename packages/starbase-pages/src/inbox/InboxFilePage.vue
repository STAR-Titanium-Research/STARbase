<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
	AppLink, FactList, LoadState, NotVisible, PageShell, RecordLayout, Section, formatDate, openLink, useExplorerHost, useInboxSummary,
	type ContentsEntry, type Fact,
} from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import '../labels/form.css';
import AddScanDialog from './AddScanDialog.vue';
import CompareStage from './CompareStage.vue';
import type { CompareMeasure, PartnerState } from './comparePartner';
import FactsDiff from './FactsDiff.vue';
import InboxFileRail from './InboxFileRail.vue';
import LinkDialog from './LinkDialog.vue';
import ViewBox from './ViewBox.vue';
import ViewBoxRail from './ViewBoxRail.vue';
import { loadFiles, type FoundFile } from './inboxApi';
import { locateFile, LOCATE_PAGE, type Located } from './inboxFileList';
import {
	IMAGE_KINDS, duplicateText, extractedText, filtersToQuery, folderOf, hasThumbnail, listPlan, nameOf, needsReadNotice, parseFilters, primaryAction, settingsOf, suggestionOf,
} from './inboxModel';
import type { ScanAddForm } from './inboxScan';
import { canCommonScale } from './commonScale';
import { measureScale, type MeasureLine } from './measure';
import { sheetScaleBar } from './sheetScale';
import type { PictureState } from './usePicture';
import { createInbox, type Outcome } from './useInbox';
import { useViewSettings, type CompareMode } from './useViewSettings';
import { listBase, listPath, neighbours, partnerOf, positionText, swapCandidate } from './viewBoxModel';

// The view box page (/inbox/file/:candidateId, spec 2026-10-20-inbox-file-viewer-design.md decisions 4, 8, 9 and 10): one found file on a RecordLayout page. Left,
// its detail panel (InboxFileRail); centre, the stage with the preview (ViewBox) and where the file is; right, the viewer's View rail (ViewBoxRail).
// The endpoint has no "one file" call, so the file and its neighbours come from the same filtered list the person came from, read with the filters in this
// page's URL (inboxFileList.ts); a file that is not in it shows "not found or not visible" and no prev/next, never a guess. Previous / next replace this page's
// address, so the browser's Back goes straight back to the list. Link, Dismiss and Restore are the Inbox row's own actions (useInbox), with the same refusals.
const props = defineProps<{ candidateId: string }>();
const host = useExplorerHost();
const route = useRoute();
const router = useRouter();
const summary = useInboxSummary(host);
const view = useViewSettings();

const filters = computed(() => parseFilters(route.query));
const filtersKey = computed(() => JSON.stringify(filtersToQuery(filters.value)));
const closeTo = computed(() => listPath(filters.value));

// ---- the file, found in the list it came from ----
const located = ref<Located | null>(null);
const status = ref<'loading' | 'ready' | 'missing' | 'error'>('loading');
const failure = ref('');
let token = 0;
async function reload(): Promise<void> {
	const mine = ++token;
	if (!located.value) status.value = 'loading';
	try {
		const got = await locateFile(host.api, filters.value, props.candidateId, () => mine !== token);
		if (mine !== token) return;
		located.value = got;
		status.value = got ? 'ready' : 'missing';
	} catch (e) {
		if (mine !== token) return;
		failure.value = e instanceof Error && e.message ? e.message : 'Could not load this file.';
		status.value = 'error';
	}
}
const file = computed<FoundFile | null>(() => located.value?.rows.find((f) => f.candidate_id === props.candidateId) ?? null);
const around = computed(() => (located.value ? neighbours(located.value.rows.map((f) => f.candidate_id), props.candidateId) : null));
const position = computed(() => (around.value && located.value ? { text: positionText(around.value.index, located.value.total), hasPrev: !!around.value.prev, hasNext: !!around.value.next } : null));

const inbox = createInbox({ api: host.api, getFilters: () => filters.value, onChanged: () => void summary.refresh() });
const { notice } = inbox;
const showOwner = computed(() => (summary.summary.value?.teams.length ?? 0) > 0);
const tab = computed(() => filters.value.tab);

onMounted(() => {
	void reload();
	void summary.refresh();
	document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
	token += 1;
	inbox.cancel();
	document.removeEventListener('keydown', onKey);
	clearTimeout(copyTimer);
});
watch(filtersKey, () => void reload());
// Previous / next change the file in the same page: the list is already in hand. Only a file it does not hold (an address typed in) asks again.
watch(
	() => props.candidateId,
	() => {
		copied.value = false;
		if (!file.value) void reload();
	},
);

// ---- moving between files ----
const go = (id: string | null | undefined) => {
	if (id) void router.replace({ path: swapCandidate(route.path, id), query: route.query });
};
const prev = () => go(around.value?.prev);
const next = () => go(around.value?.next);
const toList = () => openLink(closeTo.value, router);
const pictureState = ref<PictureState>('idle');
const hasPicture = computed(() => !!file.value && hasThumbnail(file.value) && pictureState.value !== 'failed');
const hasScale = computed(() => !!file.value && sheetScaleBar(file.value.extracted) !== null);

// ---- Compare: the partner is `?with=<candidateId>`; only a file in the list the person can already see is ever shown ----
// The open file's own page reads the list as far as the file; a partner further down is looked for with the same filters. A partner that is in neither is
// the lock card (the page cannot tell a file the person may not see from one that is not there, and never says which). Nothing is guessed.
const partnerId = computed(() => partnerOf(route.query, props.candidateId));
const compareOn = computed(() => view.settings.compare === 'side' || !!partnerId.value);
const compareMode = computed<CompareMode>(() => (compareOn.value ? 'side' : 'off'));
function setWith(id: string | null): void {
	const query: Record<string, unknown> = { ...route.query };
	if (id) query.with = id;
	else delete query.with;
	void router.replace({ path: route.path, query: query as typeof route.query });
}
/** More of the list than the page read to find the open file, for the picker's "Load more" (the open file's list part, from where the page stopped). */
const extra = ref<FoundFile[]>([]);
const exhausted = ref(false);
const moreBusy = ref(false);
const rows = computed<FoundFile[]>(() => {
	const seen = new Set<string>();
	return [...(located.value?.rows ?? []), ...extra.value].filter((f) => !seen.has(f.candidate_id) && !!seen.add(f.candidate_id));
});
const more = computed(() => !!located.value && !exhausted.value && rows.value.length < located.value.total);
async function loadMore(): Promise<void> {
	const l = located.value;
	const base = l ? listPlan(filters.value)[l.part] : null;
	if (!l || !base || moreBusy.value) return;
	moreBusy.value = true;
	try {
		const page = await loadFiles(host.api, { ...base, limit: LOCATE_PAGE, offset: rows.value.length });
		if (located.value === l) {
			if (page.rows.length === 0) exhausted.value = true;
			extra.value = [...extra.value, ...page.rows];
		}
	} catch {
		inbox.say({ tone: 'warn', text: 'Could not load more of the list.' });
	} finally {
		moreBusy.value = false;
	}
}
watch(filtersKey, () => {
	extra.value = [];
	exhausted.value = false;
});

const partner = ref<PartnerState>({ state: 'none' });
let partnerToken = 0;
async function resolvePartner(): Promise<void> {
	const id = partnerId.value;
	const mine = ++partnerToken;
	if (!id) {
		partner.value = { state: 'none' };
		return;
	}
	const hit = rows.value.find((f) => f.candidate_id === id);
	if (hit) {
		partner.value = { state: 'ready', file: hit };
		return;
	}
	partner.value = { state: 'loading' };
	if (!located.value) return; // the list is still coming: this runs again when it is in
	try {
		const got = await locateFile(host.api, filters.value, id, () => mine !== partnerToken);
		if (mine !== partnerToken) return;
		const f = got?.rows.find((r) => r.candidate_id === id);
		if (f) {
			if (got!.part === located.value?.part) extra.value = [...extra.value, ...got!.rows];
			partner.value = { state: 'ready', file: f };
		} else partner.value = { state: 'locked' };
	} catch {
		if (mine !== partnerToken) return;
		partner.value = { state: 'none' };
		inbox.say({ tone: 'warn', text: 'Could not load the second file.' });
	}
}
watch([partnerId, located], () => void resolvePartner(), { immediate: true });
const partnerFile = computed(() => (partner.value.state === 'ready' ? partner.value.file : null));
/** The files the picker offers: pictures in the list, never the open file. */
const candidates = computed(() => rows.value.filter((f) => f.candidate_id !== props.candidateId && IMAGE_KINDS.includes(f.kind)));
const folder = computed(() => (file.value ? folderOf(file.value.rel_path) : ''));
const canCommon = computed(() => !!file.value && !!partnerFile.value && canCommonScale(file.value.extracted, partnerFile.value.extracted));
function setCompare(mode: CompareMode): void {
	view.set({ compare: mode });
	if (mode === 'off') {
		setWith(null);
		if (measure.value?.side === 'b') measure.value = null;
	}
}
const toggleCompare = () => setCompare(compareOn.value ? 'off' : 'side');
function pickPartner(id: string): void {
	view.set({ compare: 'side' });
	setWith(id);
}
function clearPartner(): void {
	view.set({ compare: 'side' }); // the second pane stays, empty, so a new pick is one click
	setWith(null);
	if (measure.value?.side === 'b') measure.value = null;
}

// ---- Measure: one line at a time, on a picture whose scale the file says ----
const measureWanted = ref(false);
const measure = ref<CompareMeasure | null>(null);
const canMeasure = computed(() => !!file.value && hasPicture.value && (!!measureScale(file.value.extracted) || (compareOn.value && !!partnerFile.value && !!measureScale(partnerFile.value.extracted))));
const measureOn = computed(() => measureWanted.value && canMeasure.value);
watch(() => props.candidateId, () => (measure.value = null));
watch(partnerId, () => {
	if (measure.value?.side === 'b') measure.value = null;
});
const singleLine = computed<MeasureLine | null>(() => measure.value?.line ?? null);

/** A file left the list (linked, dismissed, restored): go on to the next one, else the one before, else back to the list. */
function leave(): void {
	const to = around.value?.next ?? around.value?.prev ?? null;
	const gone = props.candidateId;
	if (located.value) located.value = { ...located.value, rows: located.value.rows.filter((f) => f.candidate_id !== gone), total: Math.max(0, located.value.total - 1) };
	if (to) go(to);
	else void router.replace({ path: listBase(route.path), query: filtersToQuery(filters.value) });
}
async function act(work: () => Promise<Outcome>): Promise<Outcome> {
	const r = await work();
	if (r.ok) leave();
	return r;
}
const busy = computed(() => !!file.value && inbox.isBusy(file.value.candidate_id));

// ---- Link, Dismiss, Restore: the Inbox row's own actions ----
const dialogOpen = ref(false);
const dialogBusy = ref(false);
const dialogError = ref('');
const scanOpen = ref(false);
const scanBusy = ref(false);
const scanError = ref('');
const scanField = ref('');
function link(): void {
	const f = file.value;
	if (!f) return;
	const a = primaryAction(f);
	if (a.kind === 'scan') {
		scanError.value = '';
		scanField.value = '';
		scanOpen.value = true;
	} else if (a.kind === 'link' && !needsReadNotice(f.kind)) void act(() => inbox.linkSuggested(f));
	else {
		dialogError.value = '';
		dialogOpen.value = true;
	}
}
async function choose(rec: { collection: string; id: string }) {
	const f = file.value;
	if (!f || dialogBusy.value) return;
	dialogBusy.value = true;
	dialogError.value = '';
	const r = await act(() => inbox.link(f, rec.collection, rec.id));
	dialogBusy.value = false;
	if (r.ok) dialogOpen.value = false;
	else dialogError.value = r.message;
}
async function addScan(form: ScanAddForm) {
	const f = file.value;
	if (!f || scanBusy.value) return;
	scanBusy.value = true;
	scanError.value = '';
	scanField.value = '';
	const r = await act(() => inbox.addScan(f, form));
	scanBusy.value = false;
	if (r.ok) scanOpen.value = false;
	else {
		scanError.value = r.message;
		scanField.value = r.field ?? '';
	}
}
const dismiss = () => file.value && void act(() => inbox.dismiss(file.value as FoundFile));
const restore = () => file.value && void act(() => inbox.restore(file.value as FoundFile));
async function undo(u: NonNullable<NonNullable<typeof notice.value>['undo']>) {
	const r = await inbox.undo(u);
	if (r.ok) await reload();
}

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function copyPath(): Promise<void> {
	const f = file.value;
	if (!f) return;
	try {
		await navigator.clipboard.writeText(f.rel_path);
		copied.value = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied.value = false), 2000);
	} catch {
		inbox.say({ tone: 'warn', text: 'Could not copy the path. Select it under "Where it is" instead.' });
	}
}

// ---- the keys: left / right previous and next, F fits the picture, M measures, C compares, Esc closes ----
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="radio"], [role="dialog"]';
function onKey(e: KeyboardEvent): void {
	if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
	if (dialogOpen.value || scanOpen.value) return;
	const t = e.target instanceof Element ? e.target : null;
	if (e.key === 'Escape') {
		if (e.shiftKey || t?.closest('input, textarea, select, [role="dialog"]')) return;
		e.preventDefault();
		toList();
	} else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
		if (e.shiftKey || t?.closest(TYPING)) return;
		if (!(e.key === 'ArrowLeft' ? around.value?.prev : around.value?.next)) return;
		e.preventDefault();
		if (e.key === 'ArrowLeft') prev();
		else next();
	} else if (e.key === 'f' || e.key === 'F') {
		if (t?.closest(TYPING)) return;
		e.preventDefault();
		view.set({ zoom: 'fit' });
	} else if (e.key === 'm' || e.key === 'M') {
		if (t?.closest(TYPING) || !canMeasure.value) return;
		e.preventDefault();
		measureWanted.value = !measureWanted.value;
	} else if (e.key === 'c' || e.key === 'C') {
		if (t?.closest(TYPING)) return;
		e.preventDefault();
		toggleCompare();
	}
}

// ---- the page's words ----
const pageTitle = computed(() => (file.value ? nameOf(file.value.rel_path) : 'Found file'));
const hasImaging = computed(() => !!file.value && (settingsOf(file.value).length > 0 || !!extractedText(file.value.extracted)));
const contents = computed<ContentsEntry[]>(() => [
	{ id: 'picture', title: 'Picture', count: null },
	...(hasImaging.value ? [{ id: 'imaging', title: 'Imaging settings', count: null }] : []),
	{ id: 'where', title: 'Where it is', count: null },
]);
const suggestion = computed(() => (file.value ? suggestionOf(file.value) : null));
const whereFacts = computed<Fact[]>(() => {
	const f = file.value;
	if (!f) return [];
	return [
		{ label: 'Path', value: f.rel_path, mono: true },
		{ label: 'First seen', value: formatDate(f.first_seen_at) },
		{ label: 'Linked to', value: f.linked_label },
		{ label: 'Copy', value: duplicateText(f) },
	];
});
</script>

<template>
	<ExplorerView :title="pageTitle">
		<template #headline><AppLink to="/home">Home</AppLink></template>
		<PageShell>
			<LoadState v-if="status === 'loading' || (status === 'ready' && !file)" loading loading-text="Loading file…" />

			<NotVisible v-else-if="status === 'missing'" what="found file" />

			<LoadState v-else-if="status === 'error'" :error="failure" />

			<template v-else-if="file">
				<!-- 70px: the Data Studio's header bar is 54px, plus a 16px gap. -->
				<RecordLayout style="--d1-sticky-top: var(--d1-header-offset, 70px)">
					<template #crumbs>
						<AppLink to="/home">Home</AppLink>
						<span>›</span>
						<AppLink :to="closeTo" data-test="crumb-inbox">Inbox</AppLink>
						<span>›</span>
						<span class="here">{{ pageTitle }}</span>
					</template>

					<template #rail>
						<InboxFileRail
							:file="file"
							:tab="tab"
							:show-owner="showOwner"
							:busy="busy"
							:copied="copied"
							:contents="contents"
							@link="link"
							@dismiss="dismiss"
							@restore="restore"
							@copy="copyPath"
						/>
					</template>

					<div class="status" role="status" aria-live="polite" data-test="status">
						<p v-if="notice" class="banner" :class="notice.tone" data-test="notice">
							<span>{{ notice.text }}</span>
							<button v-if="notice.undo" type="button" class="lf-link" :disabled="inbox.undoing.value !== null" data-test="undo" @click="undo(notice.undo)">Undo</button>
							<button type="button" class="lf-link close" @click="inbox.dismissNotice()">Close</button>
						</p>
					</div>

					<div class="work">
						<div class="col">
							<div id="picture" class="picture">
								<ViewBox
									:file="file"
									:position="position"
									:close-to="closeTo"
									:zoom="view.settings.zoom"
									:scale-bar="view.settings.scaleBar"
									:contrast="view.settings.contrast"
									:measure-on="measureOn"
									:line="singleLine"
									:compare="compareOn"
									@prev="prev"
									@next="next"
									@state="pictureState = $event"
									@measure="measure = $event ? { line: $event, side: 'a' } : null"
								>
									<template #stage>
										<CompareStage
											:file="file"
											:partner="partner"
											:zoom="view.settings.zoom"
											:scale-bar="view.settings.scaleBar"
											:contrast="view.settings.contrast"
											:link-zoom="view.settings.linkZoom"
											:common-scale="view.settings.commonScale"
											:measure-on="measureOn"
											:measure="measure"
											@state="pictureState = $event"
											@measure="measure = $event"
										/>
									</template>
								</ViewBox>
								<FactsDiff v-if="compareOn && partnerFile" :a="file" :b="partnerFile" />
							</div>
							<Section id="where" title="Where it is">
								<FactList :facts="whereFacts" />
								<p v-if="suggestion" class="why" data-test="where-suggestion">Looks like <strong class="rec">{{ suggestion.record }}</strong>: <span class="reason">{{ suggestion.text }}</span></p>
							</Section>
						</div>
						<ViewBoxRail
							:measure="measureWanted"
							:can-measure="canMeasure"
							:has-line="!!measure"
							:compare="compareMode"
							:link-zoom="view.settings.linkZoom"
							:common-scale="view.settings.commonScale"
							:can-common="canCommon"
							:candidates="candidates"
							:folder="folder"
							:partner="partnerFile"
							:partner-locked="partner.state === 'locked'"
							:more="more"
							:more-busy="moreBusy"
							:zoom="view.settings.zoom"
							:scale-bar="view.settings.scaleBar"
							:contrast="view.settings.contrast"
							:has-picture="hasPicture"
							:has-scale="hasScale"
							:open="view.settings.boxRailOpen"
							@update:zoom="view.set({ zoom: $event })"
							@update:scale-bar="view.set({ scaleBar: $event })"
							@update:contrast="view.set({ contrast: $event })"
							@update:open="view.set({ boxRailOpen: $event })"
							@update:measure="measureWanted = $event"
							@update:compare="setCompare"
							@update:link-zoom="view.set({ linkZoom: $event })"
							@update:common-scale="view.set({ commonScale: $event })"
							@clear-line="measure = null"
							@pick="pickPartner"
							@clear-partner="clearPartner"
							@more="loadMore"
						/>
					</div>
				</RecordLayout>

				<LinkDialog v-model="dialogOpen" :file="file" :busy="dialogBusy" :error="dialogError" @choose="choose" />
				<AddScanDialog v-model="scanOpen" :file="file" :busy="scanBusy" :error="scanError" :error-field="scanField" @submit="addScan" />
			</template>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.here { font-family: var(--theme--fonts--monospace--font-family, monospace); overflow-wrap: anywhere; }
.status { display: flex; flex-direction: column; gap: 8px; }
.status:empty { display: none; }
.banner {
	display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 8px 14px; border-radius: 10px; font-size: var(--fs-md, 13px);
	border: 1px solid color-mix(in srgb, var(--banner-ink) 40%, transparent); background: color-mix(in srgb, var(--banner-ink) 12%, transparent); color: var(--theme--foreground);
	--banner-ink: var(--d1-ok);
}
.banner.warn { --banner-ink: var(--d1-warn); }
.banner.bad { --banner-ink: var(--d1-bad); }
.banner .close { margin-left: auto; color: var(--d1-dim); font-weight: 400; }
/* The stage and its notes on the left, the viewer's View rail hanging on the right; under 760px of page the rail is a card under the stage. */
.work { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
.col { flex: 1 1 0; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.picture { min-width: 0; }
.why { margin: 8px 0 0; font-size: var(--fs-sm, 12px); }
.reason { color: var(--d1-dim); }
.rec { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; }
@container (max-width: 760px) { .work { flex-direction: column; align-items: stretch; } }
</style>
