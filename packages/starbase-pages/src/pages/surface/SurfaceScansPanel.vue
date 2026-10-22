<script setup lang="ts">
// The "Surface scans" panel of an insert or an edge page: every scan with its thumbnail, condition, date, render
// status and a way to open it in 3D; "Render again" on a failed one; "Add a surface scan". An edge's panel also
// lists the scans of its insert, tagged as such. A scan whose file belongs to someone else is a lock tile (condition,
// date and operation only; no file, notes, thumbnail, Open or Render again) and still counts. Reads and writes as the signed-in user. The viewer opens inline
// under the list, so the page keeps its place and its single WebGL context.
import { computed, nextTick, ref, toRef, watch } from 'vue';
import { LIST_CAP, LoadState, RecordLink, Section, formatDate, useExplorerHost } from '@d1/ui';
import AddSurfaceScanDialog from './AddSurfaceScanDialog.vue';
import ScanStatusBadge from './ScanStatusBadge.vue';
import SurfaceScanViewer from './viewer/SurfaceScanViewer.vue';
import { isFileLocked, renderAgain, scanErrorText } from './scanApi';
import { canOpenScan, canRenderAgain, conditionLabel, LOCKED_SCAN_TEXT, scanOwner, type ScanRow } from './scanModel';
import { useScanThumbs } from './useScanThumbs';
import { useSurfaceScans } from './useSurfaceScans';

const props = defineProps<{
	insertId: string;
	/** Set on an edge page. */
	edgeId?: string | null;
	/** "Insert CNMG12-1" or "Edge CNMG12-1-3B", for the dialog's title. */
	itemLabel: string;
}>();

const host = useExplorerHost();
const edge = computed(() => props.edgeId ?? null);
const { state, rows, capped, reload } = useSurfaceScans(toRef(props, 'insertId'), edge);
const { urls, retry, drop } = useScanThumbs(rows, (id) => onLocked(id));

// A Lab Viewer looks and changes nothing: no button that adds or renders.
const canWrite = computed(() => !host.canViewAllAccess.value);

const adding = ref(false);
const openId = ref<string | null>(null);
const viewerEl = ref<HTMLElement | null>(null);
const busy = ref<Set<string>>(new Set());
const actionError = ref<Record<string, string>>({});

// Another insert or edge: the open scan belonged to the last one.
watch(() => [props.insertId, props.edgeId], () => { openId.value = null; });

// Only a finished render can be shown: a scan sent to render again closes its view.
const opened = computed(() => rows.value.find((r) => r.id === openId.value && canOpenScan(r)) ?? null);
// Readable rows only: a locked row has no file id to offer (and the add dialog's own file list is what the caller can read anyway).
const takenFileIds = computed(() => rows.value.filter((r) => !r.locked && scanOwner(r, edge.value) === 'own' && r.file).map((r) => r.file!.id));
const emptyText = computed(() => (edge.value ? 'No surface scan of this edge or its insert.' : 'No surface scan of this insert.'));
const fileName = (r: ScanRow) => r.file?.name ?? 'File not visible to you';

// A scan's file got an owner after this list was read (a viewer, a thumbnail or Render again answered 403 FILE_LOCKED): its row still
// shows the file name, note, thumbnail and buttons, and a finished row is not polled. Close its view, drop the cached picture and read
// the list again, so the row comes back as a lock tile.
function onLocked(id: string): void {
	if (openId.value === id) openId.value = null;
	drop(id);
	void reload();
}

async function open(r: ScanRow): Promise<void> {
	openId.value = r.id;
	await nextTick();
	viewerEl.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

async function again(r: ScanRow): Promise<void> {
	if (busy.value.has(r.id)) return;
	busy.value = new Set(busy.value).add(r.id);
	actionError.value = { ...actionError.value, [r.id]: '' };
	try {
		await renderAgain(host.api, r.id);
		retry();
		await reload();
	} catch (e) {
		actionError.value = { ...actionError.value, [r.id]: scanErrorText(e) };
		if (isFileLocked(e)) onLocked(r.id);
	} finally {
		const next = new Set(busy.value);
		next.delete(r.id);
		busy.value = next;
	}
}

function onRerendered(): void {
	openId.value = null;
	retry();
	void reload();
}

function onAdded(): void {
	retry();
	void reload();
}
</script>

<template>
	<Section id="scans" title="Surface scans" :count="state.loading && !rows.length ? null : rows.length" :empty="!state.loading && !state.error && !rows.length" :empty-text="emptyText">
		<template #actions>
			<v-button v-if="canWrite" small @click.stop="adding = true">Add a surface scan</v-button>
		</template>

		<LoadState v-if="state.loading && !rows.length" loading loading-text="Loading surface scans…" />
		<LoadState v-else-if="state.error" :error="state.error" />

		<ul v-if="rows.length" class="scans" data-testid="surface-scan-list">
			<li v-for="r in rows" :key="r.id" class="scan" :data-status="r.locked ? 'locked' : (r.status ?? 'unknown')" :data-locked="r.locked ? 'true' : null" :class="{ current: r.id === openId, locked: r.locked }">
				<div class="thumb">
					<span v-if="r.locked" class="ph" aria-hidden="true"><v-icon name="lock" small /></span>
					<template v-else>
						<img v-if="urls[r.id]" :src="urls[r.id]" :alt="`Height map of ${fileName(r)}`" />
						<span v-else class="ph" aria-hidden="true"><v-icon :name="canRenderAgain(r) ? 'error' : 'view_in_ar'" small /></span>
					</template>
				</div>
				<div class="main">
					<div class="top">
						<span v-if="r.locked" class="file lockedtext">{{ LOCKED_SCAN_TEXT }}</span>
						<template v-else>
							<span class="file">{{ fileName(r) }}</span>
							<ScanStatusBadge :status="r.status" />
						</template>
						<span v-if="scanOwner(r, edge) === 'insert'" class="tag">Insert</span>
					</div>
					<div class="meta">
						<span class="cond">{{ conditionLabel(r.condition) }}</span>
						<span :class="{ dim: !r.scannedOn }">{{ formatDate(r.scannedOn, 'undated') }}</span>
						<span v-if="r.operation">after <RecordLink collection="manufacturing_operations" :id="r.operation.id" class="mono">{{ r.operation.label }}</RecordLink></span>
					</div>
					<p v-if="!r.locked && r.conditionNote" class="note">{{ r.conditionNote }}</p>
					<p v-if="!r.locked && r.status === 'failed'" class="fail" role="alert">{{ r.renderError ?? 'The render failed; no reason was recorded.' }}</p>
					<p v-if="!r.locked && actionError[r.id]" class="fail" role="alert">{{ actionError[r.id] }}</p>
				</div>
				<div v-if="!r.locked" class="act">
					<v-button v-if="canOpenScan(r)" small secondary :aria-label="`Open ${fileName(r)} in 3D`" @click="open(r)">Open in 3D</v-button>
					<v-button v-if="canRenderAgain(r) && canWrite && r.canEdit !== false" small secondary :loading="busy.has(r.id)" @click="again(r)">Render again</v-button>
				</div>
			</li>
		</ul>
		<p v-if="capped" class="d1-note cap">Showing the newest {{ LIST_CAP }} scans.</p>

		<div v-if="opened" ref="viewerEl" class="viewer" data-testid="surface-scan-open">
			<div class="vhead">
				<strong>{{ fileName(opened) }}</strong>
				<span class="vsub">{{ conditionLabel(opened.condition) }} · {{ formatDate(opened.scannedOn, 'undated') }}</span>
				<span class="spacer" />
				<v-button small secondary @click="openId = null">Close</v-button>
			</div>
			<SurfaceScanViewer :scan-id="opened.id" :title="fileName(opened)" @rerendered="onRerendered" @locked="onLocked" />
		</div>
	</Section>

	<AddSurfaceScanDialog v-model="adding" :insert-id="insertId" :edge-id="edge" :item-label="itemLabel" :taken-file-ids="takenFileIds" @added="onAdded" />
</template>

<style scoped>
.scans { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.scan { display: grid; grid-template-columns: 76px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 10px 0; border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.scan:first-child { border-top: 0; padding-top: 0; }
.thumb { width: 76px; height: 56px; border-radius: 6px; overflow: hidden; background: var(--d1-tile, var(--theme--background-subdued)); border: 1px solid var(--d1-line, var(--theme--border-color-subdued)); display: grid; place-items: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ph { color: var(--d1-dim, var(--theme--foreground-subdued)); display: inline-flex; }
[data-status='failed'] .ph { color: var(--d1-bad, var(--theme--danger)); }
.main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.file { font-weight: 650; overflow-wrap: anywhere; }
.lockedtext { font-weight: 600; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.tag { font-size: var(--fs-xs, 11px); font-weight: 700; padding: 1px 7px; border-radius: 99px; color: var(--d1-dim, var(--theme--foreground-subdued)); background: var(--theme--background-normal); }
.meta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.cond { color: var(--theme--foreground); font-weight: 600; }
.dim { color: var(--d1-dim, var(--theme--foreground-subdued)); }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.note { margin: 0; font-size: var(--fs-sm, 12px); white-space: pre-wrap; overflow-wrap: anywhere; }
.fail { margin: 2px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-bad, var(--theme--danger)); overflow-wrap: anywhere; }
.act { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.cap { margin-top: 10px; }
.viewer { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued)); scroll-margin-top: calc(var(--d1-sticky-top, 0px) + 8px); }
.vhead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.vsub { font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.spacer { flex: 1; }
@media (max-width: 560px) {
	.scan { grid-template-columns: 76px minmax(0, 1fr); }
	.act { grid-column: 1 / -1; flex-direction: row; }
}
</style>
