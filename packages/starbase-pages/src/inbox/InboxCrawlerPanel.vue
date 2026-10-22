<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { AppLink, FactList, LoadState, Section, useExplorerHost } from '@d1/ui';
import { adminFacts, aliasRows, daemonView, scanState, unmatchedRows, whenText } from './adminView';
import { FOLDERS_KNOWN_HELP } from './progressModel';
import ScanFoldersTable from './ScanFoldersTable.vue';
import { createInboxAdmin } from './useInboxAdmin';
import { createScanProgress } from './useScanProgress';

// The Inbox crawler tab of /crawler (admins only; CrawlerPage gates it): is the daemon alive, when it last scanned, what went wrong, the folders
// under Users/ and Shared/ that match no one (never scanned), the people with no uni alias, and Scan all. Read from d1-inbox's admin route as the
// administrator; polled calmly while the tab is visible. The share itself is never touched from here.
const admin = createInboxAdmin(useExplorerHost().api);
const { data, loading, error, missing, scanning, note, actionError } = admin;
// The scan progress of every folder (the Folders table). It counts every file, so it is asked less often than the status above.
const progress = createScanProgress(useExplorerHost().api, { all: true });

const POLL_MS = 15_000;
const PROGRESS_EVERY_MS = 60_000;
let progressAt = 0;
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const tick = () => {
	if (document.hidden) return;
	now.value = Date.now();
	void admin.load();
	if (now.value - progressAt >= PROGRESS_EVERY_MS) loadProgressNow();
};
function loadProgressNow() {
	progressAt = Date.now();
	void progress.load();
}
onMounted(() => {
	void admin.load();
	loadProgressNow();
	timer = setInterval(tick, POLL_MS);
});
onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
	admin.cancel();
	progress.cancel();
});

const status = computed(() => data.value?.status ?? null);
const progressFolders = computed(() => progress.folders.value);
const scanFinished = computed(() => !!(progress.lastScanFinishedAt.value ?? status.value?.last_scan_finished_at));
const daemon = computed(() => daemonView(status.value, now.value));
const facts = computed(() => adminFacts(status.value));
const scan = computed(() => scanState(status.value, now.value));
const scanText = computed(() => ({ never: 'No scan has run yet.', running: 'A scan is running now.', done: `Last scan finished ${whenText(status.value?.last_scan_finished_at)}.`, interrupted: 'The last scan did not finish: the daemon stopped during it.' })[scan.value]);
const unmatched = computed(() => unmatchedRows(data.value?.unmatched_folders ?? []));
const noAlias = computed(() => aliasRows(data.value?.people_without_alias ?? []));
const errors = computed(() => {
	const list = data.value?.errors ?? [];
	const last = status.value?.last_error;
	return last && !list.some((e) => e.message === last) ? [{ at: null, message: last }, ...list] : list;
});
</script>

<template>
	<div class="ic" data-test="inbox-crawler">
		<p class="d1-note">The inbox crawler lists each person's and team's folder on the lab share, read-only, and offers the new files in the Inbox.</p>

		<p v-if="missing === 'no-endpoint'" class="banner warn" role="status" data-test="ic-missing">The server has no Inbox yet (d1-inbox is not deployed), so there is nothing to show here.</p>
		<p v-else-if="missing === 'not-admin'" class="banner warn" role="alert">Only administrators can see the Inbox crawler.</p>
		<LoadState v-else-if="loading" loading loading-text="Loading the Inbox crawler…" />

		<template v-else>
			<p v-if="error" class="banner bad" role="alert">{{ error }}</p>
			<p v-if="actionError" class="banner bad" role="alert">{{ actionError }}</p>
			<p v-if="note" class="banner ok" role="status">{{ note }}</p>

			<div class="cols">
				<Section title="Daemon">
					<template #actions>
						<span class="pill" :class="`tone-${daemon.tone}`" data-test="ic-daemon">{{ daemon.label }}</span>
						<v-button x-small :loading="scanning" data-test="ic-scan-all" @click="admin.scanAllNow()"><v-icon name="radar" x-small left />Scan all</v-button>
					</template>
					<p class="d1-note" data-test="ic-scan-state">{{ scanText }}<template v-if="(data?.queued_requests ?? 0) > 0"> {{ data?.queued_requests }} scan request{{ data?.queued_requests === 1 ? '' : 's' }} waiting.</template></p>
					<FactList :facts="facts" :columns="1" />
				</Section>

				<Section title="Errors" :count="errors.length" :empty="!errors.length" empty-text="No errors.">
					<ul class="errs" data-test="ic-errors">
						<li v-for="(e, i) in errors" :key="i"><span v-if="e.at" class="when">{{ whenText(e.at) }}</span><span class="msg">{{ e.message }}</span></li>
					</ul>
				</Section>
			</div>

			<Section title="Folders" :count="progressFolders.length" :empty="progress.loaded.value && !progressFolders.length" empty-text="No folder has an alias or a share folder yet." data-test="ic-folders">
				<p v-if="progress.error.value" class="banner bad" role="alert">{{ progress.error.value }}</p>
				<LoadState v-else-if="!progress.loaded.value" loading loading-text="Loading the scan progress…" />
				<template v-else>
					<p class="d1-note" data-test="ic-folders-help">How far the crawler has read each folder it scans, largest first. {{ FOLDERS_KNOWN_HELP }}</p>
					<ScanFoldersTable :folders="progressFolders" :scan-finished="scanFinished" />
				</template>
			</Section>

			<div class="cols">
				<Section title="Folders no one owns" :count="unmatched.length" :empty="!unmatched.length" empty-text="Every folder under Users and Shared belongs to someone.">
					<p class="d1-note">These are not scanned.</p>
					<ul class="list" data-test="ic-unmatched">
						<li v-for="r in unmatched" :key="r.path"><span class="mono">{{ r.path }}</span><span class="hint">{{ r.hint }}</span></li>
					</ul>
				</Section>

				<Section title="People without a uni alias" :count="noAlias.length" :empty="!noAlias.length" empty-text="Every active person has a uni alias.">
					<p class="d1-note">Their personal folder is not scanned until an administrator sets a uni alias on the People page.</p>
					<ul class="list" data-test="ic-no-alias">
						<li v-for="p in noAlias" :key="p.id">
							<AppLink :to="p.to" class="name">{{ p.name }}</AppLink><span v-if="p.note" class="hint">{{ p.note }}</span>
						</li>
					</ul>
				</Section>
			</div>
		</template>
	</div>
</template>

<style scoped>
.ic { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.banner {
	display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin: 0; padding: 8px 14px; border-radius: 10px; font-size: var(--fs-md);
	border: 1px solid color-mix(in srgb, var(--banner-ink) 40%, transparent); background: color-mix(in srgb, var(--banner-ink) 12%, transparent); color: var(--banner-ink);
	--banner-ink: var(--d1-ok);
}
.banner.warn { --banner-ink: var(--d1-warn); }
.banner.bad { --banner-ink: var(--d1-bad); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 16px; align-items: start; }
.pill {
	padding: 1px 8px; border-radius: 99px; font-size: var(--fs-xs); font-weight: 700; line-height: 1.6; white-space: nowrap;
	color: var(--pill-ink); background: color-mix(in srgb, var(--pill-ink) 14%, transparent);
}
.pill.tone-success { --pill-ink: var(--d1-ok); }
.pill.tone-warning { --pill-ink: var(--d1-warn); }
.pill.tone-danger { --pill-ink: var(--d1-bad); }
.list, .errs { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
.errs li { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.msg { color: var(--d1-bad); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.when { color: var(--d1-dim); font-size: var(--fs-sm); white-space: nowrap; }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.hint { color: var(--d1-dim); font-size: var(--fs-sm); }
.name { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; text-decoration: none; }
.name:hover { text-decoration: underline; }
</style>
