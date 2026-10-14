<script setup lang="ts">
import ExplorerView from '../../ExplorerView.vue';
import { computed, onBeforeUnmount, provide, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { VueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import { AppLink, Finder, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, Section, SegmentedControl, indexRoute, recordRoute, useExplorerHost } from '@d1/ui';
import type { Dir } from './model/elkInput';
import { MAP_ACTIONS, MAP_VIEW, type MapActions, type MapView } from './nodes/actions';
import { KINDS } from './nodes/kinds';
import { miniMapColor, useMapCanvas } from './useMapCanvas';
import { useProcessMap } from './useProcessMap';

// The Process map (spec D1-D3, §6.1): a record's family as a map of what was done to it. The page frame,
// the crumb line, the rail (left, 300 px) and the map panel. The state is useProcessMap's, the drawing
// is useMapCanvas's; this file puts them together. The rail here is a placeholder (selected record and
// "Open record"): the full rail, hover card and wire tooltip read `map.selected`, `map.hovered` and
// `map.tooltip` and arrive with Task 8.
const host = useExplorerHost();
const route = useRoute();
const router = useRouter();
const map = useProcessMap(host.api, route, router);
const canvas = useMapCanvas(map);

// What the node and wire components call (nodes/actions.ts).
const actions: MapActions = {
	select: (id, opts) => map.select(id, opts),
	expand: (id) => {
		map.expand(id);
		void canvas.remeasure(id);
	},
	hover: (id, el) => map.hover(id, el),
	toggleRows: (id) => map.toggleRows(id),
	toggleMore: (id) => {
		map.toggleMore(id);
		// The card grows or shrinks: measure it, then lay out again so it does not overlap its neighbours.
		void canvas.remeasure(id).then(() => canvas.relayout());
	},
};
const view: MapView = { direction: map.dir, moreOpen: map.moreOpen, selectedRef: map.selectedRefKey };
provide(MAP_ACTIONS, actions);
provide(MAP_VIEW, view);

const focusCode = computed(() => map.data.value?.focus.code ?? '');
const pageTitle = computed(() => (map.status.value === 'ready' && focusCode.value ? `${focusCode.value} · Process map` : 'Process map'));

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

const selectedKind = computed(() => {
	const k = map.selected.value?.kind;
	return k && k in KINDS ? KINDS[k as keyof typeof KINDS].label : 'Record';
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
		<PageShell>
			<LoadState v-if="map.status.value === 'loading'" loading loading-text="Loading the Process map…" />

			<NotVisible v-else-if="map.status.value === 'notVisible'" what="sample" />

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

			<RecordLayout v-else class="d1-process-map" style="--d1-sticky-top: var(--d1-header-offset, 70px)">
				<template #crumbs>
					<AppLink :to="indexRoute('physical_samples')">Samples</AppLink>
					<span>›</span>
					<RecordLink collection="physical_samples" :id="map.data.value?.focus.id">{{ focusCode }}</RecordLink>
					<span>›</span>
					<span>Process map</span>
				</template>

				<template #title-actions>
					<v-button small secondary @click="copyLink"><v-icon name="link" small /> {{ copied ? 'Copied' : 'Copy link' }}</v-button>
				</template>

				<template #rail>
					<RecordRail :kind="selectedKind" :code="map.selected.value?.ref.code ?? focusCode" :facts="[]">
						<template #actions>
							<v-button v-if="map.selected.value" small secondary :to="recordRoute(map.selected.value.ref.collection, map.selected.value.ref.id)">Open record</v-button>
						</template>
					</RecordRail>
				</template>

				<Section class="pm-panel" title="Process map">
					<template #actions>
						<v-button small secondary @click="finderOpen = true"><v-icon name="search" small /> Find a record</v-button>
						<SegmentedControl :model-value="map.dir.value" :options="DIRECTIONS" label="Direction" @update:model-value="map.setDir" />
						<v-button small secondary @click="canvas.relayout()">Re-layout</v-button>
						<v-button small secondary @click="canvas.fit()">Fit</v-button>
						<v-button small secondary @click="map.clearFocus()">Clear</v-button>
					</template>

					<div v-if="map.partial.value" class="pm-banner" role="status">Showing part of this history. The map shows the nearest steps; the rest is cut at the limits.</div>
					<div v-if="canvas.layoutError.value" class="pm-banner pm-bad" role="alert">{{ canvas.layoutError.value }}</div>

					<div class="pm-canvas" :class="{ pending: !canvas.laidOut.value }" @mouseleave="map.clearHover()">
						<VueFlow
							:node-types="canvas.nodeTypes"
							:edge-types="canvas.edgeTypes"
							:nodes-draggable="true"
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
							<MiniMap pannable zoomable :node-color="miniMapColor" mask-color="color-mix(in srgb, var(--theme--background) 70%, transparent)" />
							<Controls :show-interactive="false" />
						</VueFlow>
					</div>
				</Section>
			</RecordLayout>
		</PageShell>
		<Finder v-if="finderOpen" :pick-record="(r) => map.setFocus(r.collection, r.id)" @close="finderOpen = false" />
	</ExplorerView>
</template>

<style scoped>
.pm-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 24px 8px; max-width: 560px; }
.pm-empty h2 { margin: 0; font-size: var(--fs-xl, 18px); }
.pm-empty p { margin: 0; color: var(--d1-dim, var(--theme--foreground-subdued)); }

/* The canvas fills what is left of the window under the page header; the panel's body has no padding. */
.pm-panel :deep(.body) { padding: 0; }
.pm-panel :deep(.head) { flex-wrap: wrap; }
.pm-panel :deep(.head .spacer) { min-width: 0; }
.pm-canvas {
	position: relative;
	height: clamp(420px, calc(100vh - var(--d1-header-offset, 72px) - 200px), 900px);
	height: clamp(420px, calc(100dvh - var(--d1-header-offset, 72px) - 200px), 900px);
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
/* Phones pinch and pan the map; the minimap would cover it (spec D24). */
@media (max-width: 767px) {
	.pm-canvas :deep(.vue-flow__minimap) { display: none; }
}
</style>
