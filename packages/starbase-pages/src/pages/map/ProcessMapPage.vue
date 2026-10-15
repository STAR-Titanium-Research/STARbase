<script setup lang="ts">
import ExplorerView from '../../ExplorerView.vue';
import { computed, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { VueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import { AppLink, Finder, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, Section, SegmentedControl, indexRoute, useExplorerHost } from '@d1/ui';
import type { Dir } from './model/elkInput';
import { recordWord } from './model/fans';
import { MAP_ACTIONS, MAP_EDIT, MAP_VIEW, refKey, type MapActions, type MapView } from './nodes/actions';
import { socketLabeller } from './nodes/a11y';
import EditLid from './edit/EditLid.vue';
import type { MenuTarget } from './edit/menuTarget';
import { canvasEditOf, useEditCanvas } from './edit/useEditCanvas';
import { provideEditMode, useEditMode } from './edit/useEditMode';
import WirePreview from './edit/WirePreview.vue';
import ExportFrame from './ExportFrame.vue';
import ExportMenu from './ExportMenu.vue';
import HoverCard from './HoverCard.vue';
import MapRail from './MapRail.vue';
import MapSheet from './MapSheet.vue';
import WireTip from './WireTip.vue';
import { createPointerKind } from './useLongPress';
import { useMapInput } from './useMapInput';
import { miniMapColor, useMapCanvas } from './useMapCanvas';
import { controlsPosition, useIsPhone } from './usePhone';
import { useDataPreviews } from './useDataPreviews';
import { personName, useMapExport } from './useMapExport';
import { useProcessMap, type Reach } from './useProcessMap';

// The Process map (spec D1-D3, §6.1): a record's family as a map of what was done to it. The page frame,
// the crumb line, the rail (left, 300 px) and the map panel. The state is useProcessMap's, the drawing
// is useMapCanvas's; this file puts them together: the rail (MapRail), the hover card (HoverCard, after
// a 250 ms rest), the wire and socket tooltip (WireTip) and the data previews they show. Keyboard
// (keyboard.ts) and touch (useLongPress.ts, the bottom sheet MapSheet) are wired here too (spec D23, D24).
const host = useExplorerHost();
const route = useRoute();
const router = useRouter();
/** Below 768 px: the rail is a bottom sheet, the minimap is gone, a long press shows the hover card, and nothing can be built (E20). */
const phone = useIsPhone();
// Edit mode (spec §7.1) is made first: the map draws the draft it merges in (its overlay), and edit mode reads which card is selected from the map.
const edit = useEditMode({
	api: host.api,
	fieldsFor: (c) => host.fieldsFor(c),
	route,
	router,
	isPhone: phone,
	focus: () => map.focus.value,
	focusCode: () => map.data.value?.focus.code || undefined,
	selected: () => map.graph.value?.nodes.find((n) => n.id === map.selectedId.value),
	hint: (h) => map.hintMerge(h),
});
const map = useProcessMap(host.api, route, router, edit.overlay);
const canvas = useMapCanvas(map, canvasEditOf(edit));
provideEditMode(edit);
const canvasEl = ref<HTMLElement | null>(null);
/** The Add menu (E8): where it is open and what it is for; null while closed. */
const menu = shallowRef<MenuTarget | null>(null);
const build = useEditCanvas({ edit, map, canvas, canvasEl, openMenu: (t) => void (menu.value = t) });
provide(MAP_EDIT, build.mapEdit);
const pointerKind = createPointerKind();

// What the node and wire components call (nodes/actions.ts).
const actions: MapActions = {
	select: (id, opts) => map.select(id, opts),
	expand: (id) => {
		void map.expand(id); // loads what is missing, shows what is one step beyond
		void canvas.remeasure(id);
	},
	// A finger's tap sends an emulated mouseenter; the card is for a long press (below), not for every tap.
	hover: (id, el) => {
		if (id !== null && pointerKind.touch) return;
		map.hover(id, el);
	},
	collapse: (id) => map.collapse(id),
	unstack: (id) => map.unstack(id),
	toggleRows: (id) => map.toggleRows(id),
	toggleMore: (id) => {
		map.toggleMore(id);
		// The card grows or shrinks: measure it, then lay out again so it does not overlap its neighbours.
		void canvas.remeasure(id).then(() => canvas.relayout());
	},
};
// What a socket connects, for its aria-label: one pass over the wires per graph, not per socket.
const drawnNodes = computed(() => new Map(map.nodes.value.map((n) => [n.id, n])));
const labelSocket = computed(() => socketLabeller(map.graph.value?.wires ?? [], drawnNodes.value));
const view: MapView = {
	direction: map.dir,
	moreOpen: map.moreOpen,
	selectedRef: map.selectedRefKey,
	hiddenSides: map.hiddenSides,
	socketLabel: (socket, side) => labelSocket.value(socket, side),
	expanded: map.expandedIds,
};
provide(MAP_ACTIONS, actions);
provide(MAP_VIEW, view);

const focusCode = computed(() => map.data.value?.focus.code ?? '');
/** A blank canvas: edit mode with no record to map. */
const blank = computed(() => !map.focus.value);
// The record the map is opened on is not always a sample (a tool, a project, an operation...).
// The loaded record's collection; before anything is loaded (not visible) the one in the address.
const focusCollection = computed(() => map.data.value?.focus.collection ?? map.focus.value?.collection ?? 'physical_samples');
const focusWord = computed(() => recordWord(focusCollection.value));
const pageTitle = computed(() => (blank.value && edit.drafted.value ? 'Build a process' : map.status.value === 'ready' && focusCode.value ? `${focusCode.value} · Process map` : 'Process map'));

const DIRECTIONS: { value: Dir; label: string }[] = [
	{ value: 'RIGHT', label: 'Left → right' },
	{ value: 'DOWN', label: 'Top → down' },
];

// The shell owns the Finder (Ctrl+K); with no focus the page offers it as the way to pick a record.
const finderOpen = ref(false);

const frameLabel = computed(() => {
	const p = map.project.value;
	return p?.code ? [p.code, p.label].filter(Boolean).join(' · ') : '';
});
const frameStyle = computed(() => {
	const f = canvas.frame.value;
	return f ? { left: `${f.x}px`, top: `${f.y}px`, width: `${f.width}px`, height: `${f.height}px` } : null;
});

// ---- the rail, the hover card and the data they show -----------------------------------------------

// Data previews (the Fz figure, FAST run data) are read when operations arrive, so hovering and selecting only
// look the answer up (no request per hover). An expand reads just the operations it added; a new focus (the data
// is cleared first) starts afresh.
const dataPreviews = useDataPreviews(host.api);
watch(
	() => map.data.value,
	(d) => {
		if (!d) dataPreviews.reset();
		else dataPreviews.load(d.operations.filter((o) => !o.id.startsWith('draft:')).map((o) => ({ collection: 'manufacturing_operations', id: o.id, code: o.code })));
	},
	{ immediate: true },
);
const selectedPreview = computed(() => {
	const of = map.selectedInfo.value?.dataOf;
	return of ? dataPreviews.previews.value[of.id] : undefined;
});
const cardPreview = computed(() => {
	const of = map.card.value?.info.dataOf;
	return of ? dataPreviews.previews.value[of.id] : undefined;
});

/** The canvas element a rail row's record is drawn as: its card, or the card whose Inside tray holds it. */
function elementFor(id: string): HTMLElement | undefined {
	const owner = map.nodes.value.find((n) => n.id === id || (n.type === 'container' && n.slots.some((s) => [s.ref, ...(s.values ?? [])].some((r) => r && refKey(r) === id))));
	if (!owner) return undefined;
	return [...(canvasEl.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? [])].find((el) => el.dataset.id === owner.id);
}
/** A row of the rail's Connections: hovering it shows that record's card on the canvas. */
const railHover = (id: string | null) => (id === null ? map.hover(null) : map.hover(id, elementFor(id)));
const railSelect = (id: string) => {
	map.clearHover(); // the card of the row the pointer is on would stay behind where the map is about to move
	map.select(id, { centre: true });
};
/** The rail's props, one object for its two homes: the left column, and on a phone the bottom sheet. */
const railProps = computed(() => ({
	info: map.selectedInfo.value,
	preview: selectedPreview.value,
	onMap: map.selectedOnMap.value,
	connections: map.connections.value,
	highlight: map.socketHighlight.value,
	presentKinds: map.presentKinds.value,
	hiddenKinds: map.hiddenKinds.value,
	probable: map.probable.value,
	stack: map.stack.value,
	reach: map.reach.value,
	drawnReach: map.effectiveReach.value,
}));
const railExpand = () => map.selectedId.value && actions.expand(map.selectedId.value);
const railCentre = () => map.selectedId.value && map.select(map.selectedId.value, { centre: true });
const setReach = (r: Reach) => map.setReach(r);
const railEvents = { expand: railExpand, centre: railCentre, hover: railHover, select: railSelect, toggleKind: map.toggleKind, setProbable: map.setProbable, setStack: map.setStack, setReach };

// Keyboard, focus and touch (spec D23, D24): the canvas's handlers, decisions in useMapInput.ts.
const input = useMapInput({ map, canvas, canvasEl, actions, router, pointerKind });

// Export ▾ (spec D26): PNG or PDF of the whole map at the current Show settings. The off-screen frame is drawn only while it runs.
// The project frame is part of the picture only when it is drawn (the same test the template makes).
const mapExport = useMapExport({ canvas, map, projectFrame: () => (frameStyle.value && frameLabel.value ? canvas.frame.value : null), person: () => personName(host.user.value) });

// The wire tooltip's last line: where Ctrl/⌘+click goes.
const tipHint = computed(() => {
	const t = map.tooltip.value;
	const from = t?.wire ? t.lines.find((l) => l.startsWith('from ')) : undefined;
	return from ? `Ctrl/⌘+click to go to ${from.slice(5)}` : undefined;
});

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyLink() {
	try {
		await navigator.clipboard.writeText(window.location.href);
		copied.value = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied.value = false), 2000);
	} catch {
		/* no clipboard (an insecure origin or a refused permission): the address bar has the link */
	}
}
onBeforeUnmount(() => {
	if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
	<ExplorerView :title="pageTitle">
		<PageShell wide>
			<LoadState v-if="map.status.value === 'loading' || edit.pending.value" loading :loading-text="edit.pending.value ? 'Opening your draft…' : 'Loading the Process map…'" />

			<NotVisible v-else-if="map.status.value === 'notVisible'" :what="focusWord.one" />

			<template v-else-if="map.status.value === 'error'">
				<LoadState :error="map.error.value" />
				<div><v-button small secondary @click="finderOpen = true">Find a record to map</v-button></div>
			</template>

			<Section v-else-if="map.status.value === 'empty'" title="Process map" class="d1-process-map">
				<div class="pm-empty">
					<h2>Pick a record to map</h2>
					<p>The Process map shows what was done to a sample: the operations and tests, what went in and what came out, in the order they happened.</p>
					<v-button @click="finderOpen = true"><v-icon name="search" small /> Find a record to map</v-button>
				</div>
			</Section>

			<template v-else>
				<RecordLayout class="d1-process-map" style="--d1-sticky-top: var(--d1-header-offset, 70px)">
					<template #crumbs>
						<template v-if="blank">
							<AppLink to="/map">Process map</AppLink>
							<span>›</span>
							<span>{{ edit.drafted.value ? edit.draft.name.value || 'Build a process' : 'Build a process' }}</span>
						</template>
						<template v-else>
							<AppLink :to="indexRoute(focusCollection)">{{ focusWord.many }}</AppLink>
							<span>›</span>
							<RecordLink :collection="focusCollection" :id="map.data.value?.focus.id">{{ focusCode }}</RecordLink>
							<span>›</span>
							<span>Process map</span>
						</template>
					</template>

					<template #title-actions>
						<v-button v-if="edit.editing.value" small @click="edit.done()"><v-icon name="check" small /> Done editing</v-button>
						<v-button v-else-if="edit.canBuild.value && !edit.param.value" small secondary @click="edit.startEditing()"><v-icon name="edit" small /> Edit</v-button>
						<v-button small secondary @click="copyLink"><v-icon name="link" small /> {{ copied ? 'Copied' : 'Copy link' }}</v-button>
						<ExportMenu :busy="mapExport.exporting.value" :disabled="!canvas.laidOut.value || !map.nodes.value.length || mapExport.exporting.value" @pick="mapExport.exportAs" />
					</template>

					<template v-if="!phone" #rail>
						<MapRail v-bind="railProps" v-on="railEvents" />
					</template>

					<Section class="pm-panel" title="Process map">
						<template #actions>
							<v-button small secondary @click="finderOpen = true"><v-icon name="search" small /> Find a record</v-button>
							<SegmentedControl :model-value="map.dir.value" :options="DIRECTIONS" label="Direction" @update:model-value="map.setDir" />
							<v-button small secondary @click="canvas.relayout()">Re-layout</v-button>
							<v-button small secondary @click="canvas.fit()">Fit</v-button>
							<v-button small secondary :disabled="!!map.expanding.value" @click="map.reset()">Reset</v-button>
							<v-button small secondary @click="map.clearFocus()">Clear</v-button>
						</template>

						<EditLid
							v-if="edit.editing.value"
							:name="edit.draft.name.value"
							:can-undo="edit.draft.canUndo.value"
							:can-redo="edit.draft.canRedo.value"
							:drafts="edit.drafts.value"
							:current-id="edit.draft.draftId.value"
							:saving="edit.draft.saving.value"
							:save-error="edit.draft.saveError.value"
							:notice="edit.draft.notice.value"
							@undo="edit.undo()"
							@redo="edit.redo()"
							@rename="edit.draft.rename"
							@open="edit.openDraft"
							@dismiss-notice="edit.draft.notice.value = ''"
						/>
						<div v-else-if="edit.drafted.value" class="pm-banner" role="status">This draft is open to look at only: building needs a screen at least 768 px wide.</div>
						<div v-if="edit.failed.value" class="pm-banner pm-bad" role="alert">{{ edit.failed.value }}</div>
						<div v-if="build.problem.value" class="pm-banner pm-bad pm-dismissable" role="alert">
							<span>{{ build.problem.value }}</span>
							<button type="button" class="pm-dismiss" aria-label="Dismiss" @click="build.problem.value = ''"><v-icon name="close" x-small /></button>
						</div>
						<div v-if="map.notice.value" class="pm-banner pm-bad" role="alert">{{ map.notice.value }}</div>
						<div v-else-if="map.expanding.value" class="pm-banner" role="status">Loading more of the Process map…</div>
						<div v-if="map.partial.value" class="pm-banner" role="status">Showing part of this history. The map shows the nearest steps; the rest is cut at the limits.</div>
						<div v-if="canvas.layoutError.value" class="pm-banner pm-bad" role="alert">{{ canvas.layoutError.value }}</div>
						<div v-if="mapExport.error.value" class="pm-banner pm-bad pm-dismissable" role="alert">
							<span>{{ mapExport.error.value }}</span>
							<button type="button" class="pm-dismiss" aria-label="Dismiss" @click="mapExport.dismissError()"><v-icon name="close" x-small /></button>
						</div>
						<div v-else-if="mapExport.notice.value" class="pm-banner" role="status">{{ mapExport.notice.value }}</div>

						<div
							ref="canvasEl"
							class="pm-canvas"
							:class="{ pending: !canvas.laidOut.value && map.nodes.value.length > 0 }"
							@mouseleave="map.clearHover()"
							@keydown="input.onKey"
							@focusin="input.onFocusIn"
							@pointerdown.capture="input.onPointerDown"
							@pointermove.capture="input.onPointerMove"
							@pointerup.capture="input.onPointerEnd"
							@pointercancel.capture="input.onPointerEnd"
							@click.capture="input.onClickCapture"
							@contextmenu="input.onContextMenu"
						>
							<VueFlow
								:node-types="canvas.nodeTypes"
								:edge-types="canvas.edgeTypes"
								:nodes-draggable="true"
								:nodes-focusable="true"
								:edges-focusable="false"
								:nodes-connectable="false"
								:elements-selectable="false"
								:zoom-on-double-click="false"
								:min-zoom="0.1"
								:max-zoom="1.6"
								:only-render-visible-elements="false"
							>
								<template #zoom-pane>
									<div v-if="frameStyle && frameLabel" class="pm-frame" :style="frameStyle">
										<span class="pm-frame-label k-ink">{{ frameLabel }}</span>
									</div>
								</template>
								<Background variant="dots" :gap="22" :size="1.4" pattern-color="var(--d1-line)" />
								<MiniMap v-if="!phone" pannable zoomable :node-color="miniMapColor" mask-color="color-mix(in srgb, var(--theme--background) 70%, transparent)" />
								<Controls :show-interactive="false" :position="controlsPosition(phone)" />
							</VueFlow>
							<WireTip :lines="map.tooltip.value?.lines ?? null" :canvas="canvasEl" :hint="tipHint" />
							<WirePreview v-if="edit.editing.value" :preview="build.preview.value" :refusal="build.refusal.value" />
							<HoverCard v-if="map.card.value && canvasEl" :key="map.card.value.id" :info="map.card.value.info" :preview="cardPreview" :target="map.card.value.el" :canvas="canvasEl" />
						</div>
						<ExportFrame v-if="mapExport.framePlan.value" :plan="mapExport.framePlan.value" />
					</Section>
				</RecordLayout>
				<MapSheet v-if="phone" :title="map.selectedInfo.value?.code ?? 'Nothing selected'">
					<MapRail v-bind="railProps" v-on="railEvents" />
				</MapSheet>
			</template>
		</PageShell>
		<Finder v-if="finderOpen" :pick-record="map.pickRecord" @close="finderOpen = false" />
	</ExplorerView>
</template>

<style scoped>
.pm-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 24px 8px; max-width: 560px; }
.pm-empty h2 { margin: 0; font-size: var(--fs-xl, 18px); }
.pm-empty p { margin: 0; color: var(--d1-dim, var(--theme--foreground-subdued)); }

/* The canvas fills what is left of the window under the page header (the panel's head and the crumb line take
   about 130 px); the panel's body has no padding. */
.pm-panel :deep(.body) { padding: 0; }
.pm-panel :deep(.head) { flex-wrap: wrap; }
.pm-panel :deep(.head .spacer) { min-width: 0; }
.pm-canvas {
	position: relative;
	height: max(420px, calc(100vh - var(--d1-header-offset, 72px) - 130px));
	height: max(420px, calc(100dvh - var(--d1-header-offset, 72px) - 130px));
	background: var(--d1-surface, var(--theme--background));
	transition: opacity 0.15s;
}
/* Nodes sit at 0,0 until the first layout has run; keep them out of sight until then. */
.pm-canvas.pending { opacity: 0; }

.pm-banner {
	padding: 7px 14px;
	font-size: var(--fs-sm, 12px);
	color: var(--d1-dim, var(--theme--foreground-subdued));
	background: var(--d1-tile, var(--theme--background-subdued));
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
.pm-bad { color: var(--d1-bad, var(--theme--danger)); }
.pm-dismissable { display: flex; align-items: center; gap: 8px; }
.pm-dismissable span { flex: 1; }
.pm-dismiss { display: inline-flex; padding: 2px; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; }
.pm-dismiss:hover, .pm-dismiss:focus-visible { background: var(--d1-tile, var(--theme--background-subdued)); outline: none; }

/* The project frame (spec D13): in flow coordinates inside Vue Flow's transformed pane, behind the nodes. */
.pm-frame {
	--k: var(--k-project);
	position: absolute;
	z-index: -1;
	box-sizing: border-box;
	pointer-events: none;
	border: 1.5px dashed color-mix(in srgb, var(--k) 55%, transparent);
	border-radius: 18px;
	background: color-mix(in srgb, var(--k) 5%, transparent);
}
.pm-frame-label {
	position: absolute;
	top: 8px;
	left: 14px;
	max-width: calc(100% - 28px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: var(--fs-sm, 12px);
	font-weight: 700;
	letter-spacing: 0.02em;
}

/* Vue Flow's own panels in the kit's colours. */
.pm-canvas :deep(.vue-flow__controls) { box-shadow: var(--d1-shadow, none); border: 1px solid var(--d1-line); border-radius: 8px; overflow: hidden; }
.pm-canvas :deep(.vue-flow__controls-button) { background: var(--d1-surface); color: var(--theme--foreground); border-bottom-color: var(--d1-line); }
.pm-canvas :deep(.vue-flow__controls-button:hover) { background: var(--d1-tile); }
.pm-canvas :deep(.vue-flow__controls-button svg) { fill: currentColor; }
.pm-canvas :deep(.vue-flow__minimap) { background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: 8px; overflow: hidden; }
/* Phones pinch and pan the map (spec D24): the minimap is not drawn there (v-if), and a long press must not select text or raise the system menu. */
@media (pointer: coarse) {
	.pm-canvas { -webkit-touch-callout: none; user-select: none; }
}
</style>
