<script setup lang="ts">
import ExplorerView from '../../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { useRouter } from 'vue-router';
import {
	AppLink, EditDrawer, LIST_CAP, LoadState, NotVisible, PageShell, PinToggle, RecordLayout, RecordLink, RecordRail,
	boxDetailFacts, boxRailFacts, dataStudioRoute, detailFacts, edgeDetailFacts, edgeLabel, edgeRailFacts, edgeUsageMismatch, findEdge, findInsert,
	focusKindOf, focusRoute, indexRoute, insertDetailFacts, insertLabel, insertRailFacts, mismatchText, openLink, pinTargetForRecord, toolingTitle,
	useCanUpdate, FOCUS_COLLECTION, FOCUS_KIND_LABEL, FOCUS_NOUN, type ContentsEntry, type ToolingFocus,
} from '@d1/ui';
import { useToolingData } from './useToolingData';
import ToolingStage from './stage/ToolingStage.vue';
import ToolingDetails from './ToolingDetails.vue';
import StateBadge from './StateBadge.vue';
import BoxPanels from './BoxPanels.vue';
import InsertPanels from './InsertPanels.vue';
import EdgePanels from './EdgePanels.vue';

// Tooling page: a tool box, a cutting insert and an insert edge on ONE route record
// (:kind(tool-boxes|inserts|edges)/:id), so moving from the box to an insert to an edge keeps this
// component, and the stage's WebGL context, alive. The stage holds the selection by emitting `select`;
// the page turns it into a route, and the focus is read back from the route, so Back and Forward move
// the camera. Design: docs/superpowers/specs/2026-10-14-tooling-3d-pages-design.md.
const props = defineProps<{ kind: string; id: string }>();
const router = useRouter();

const { state, error, record, box, model, focus, nextFresh, tests, operations, edgeCounts, reload } = useToolingData(toRef(props, 'kind'), toRef(props, 'id'));

const focusKind = computed(() => focusKindOf(props.kind) ?? 'box');
const collection = computed(() => FOCUS_COLLECTION[focusKind.value]);
const insert = computed(() => (focus.value && focus.value.kind !== 'box' ? findInsert(model.value, focus.value.insertId) : null));
const edge = computed(() => (focus.value?.kind === 'edge' ? (findEdge(model.value, focus.value.edgeId)?.edge ?? null) : null));

// Edit is offered unless the server says this user may not change the record. The collection changes
// as the focus moves, so each one has its own check, asking only while it is the focused kind.
const askFor = (k: 'box' | 'insert' | 'edge') => computed(() => (focusKind.value === k ? props.id : null));
const canBox = useCanUpdate('tool_boxes', askFor('box'));
const canInsert = useCanUpdate('cutting_inserts', askFor('insert'));
const canEdge = useCanUpdate('insert_edges', askFor('edge'));
const focusedCan = computed(() => ({ box: canBox, insert: canInsert, edge: canEdge })[focusKind.value]);
const canUpdate = computed(() => focusedCan.value.canUpdate.value);
const editing = ref(false);
function onSaved() {
	reload();
	focusedCan.value.refresh();
}

function onSelect(f: ToolingFocus) {
	if (model.value) openLink(focusRoute(f, model.value.boxId), router);
}

const pageTitle = computed(() => toolingTitle(focus.value, model.value));
const studioTo = computed(() => dataStudioRoute(collection.value, props.id));
const pin = computed(() => pinTargetForRecord(collection.value, props.id));

const code = computed(() => {
	if (edge.value) return edge.value.code;
	if (insert.value) return insert.value.code;
	return model.value?.boxCode ?? '';
});
const railTitle = computed(() => {
	if (insert.value && edge.value) return `Edge ${edgeLabel(insert.value, edge.value)}`;
	if (insert.value) return insertLabel(insert.value);
	return box.value?.description ?? '';
});
const railFacts = computed(() => {
	const m = model.value;
	if (!m) return [];
	if (focusKind.value === 'box') return boxRailFacts(box.value);
	if (insert.value && edge.value) return edgeRailFacts(record.value, m, insert.value, edge.value);
	return insert.value ? insertRailFacts(record.value, m.boxId, m.boxCode) : [];
});
const details = computed(() => {
	const base = focusKind.value === 'box' ? boxDetailFacts(box.value) : edge.value ? edgeDetailFacts(record.value) : insertDetailFacts(record.value);
	return detailFacts(base, [], railFacts.value);
});
const notes = computed(() => (focusKind.value === 'box' ? box.value?.notes : record.value?.notes) ?? null);

// An edge marked fresh that tests or operations used: spec Q6, a warning, never a change of state.
const historyRows = computed(() => tests.value.data.length + operations.value.data.length);
const warning = computed(() => {
	const settled = !tests.value.loading && !operations.value.loading && !tests.value.error && !operations.value.error;
	return edge.value && settled && edgeUsageMismatch(edge.value.used, historyRows.value) ? mismatchText(historyRows.value) : '';
});

const contents = computed<ContentsEntry[]>(() => {
	if (focusKind.value === 'box') {
		return [
			{ id: 'state', title: 'Inserts by state', count: null },
			{ id: 'next', title: 'Next fresh edge', count: null },
			{ id: 'type', title: 'Insert type', count: null },
			{ id: 'inserts', title: 'Inserts', count: model.value?.inserts.length ?? null },
			{ id: 'details', title: 'Details', count: null },
		];
	}
	if (focusKind.value === 'insert') {
		return [{ id: 'details', title: 'Details', count: null }, { id: 'edges', title: 'Edges', count: insert.value?.edges.length ?? null }];
	}
	const loading = tests.value.loading || operations.value.loading;
	return [{ id: 'details', title: 'Details', count: null }, { id: 'history', title: 'History', count: loading ? null : Math.min(historyRows.value, LIST_CAP) }];
});
</script>

<template>
	<ExplorerView :title="pageTitle">
		<PageShell>
			<NotVisible v-if="state === 'notVisible'" :what="FOCUS_NOUN[focusKind]" />

			<LoadState v-else-if="state === 'error'" :error="error" />

			<template v-else-if="model && focus">
				<!-- 70px: the Data Studio's header bar is 54px, plus a 16px gap. -->
				<RecordLayout style="--d1-sticky-top: var(--d1-header-offset, 70px)">
					<template #crumbs>
						<AppLink to="/home">Home</AppLink>
						<span>›</span>
						<AppLink :to="indexRoute('tool_boxes')">Tool boxes</AppLink>
						<span>›</span>
						<RecordLink collection="tool_boxes" :id="model.boxId">Tool box {{ model.boxCode }}</RecordLink>
						<template v-if="insert">
							<span>›</span>
							<RecordLink collection="cutting_inserts" :id="insert.id">{{ insertLabel(insert) }}</RecordLink>
						</template>
						<template v-if="insert && edge">
							<span>›</span>
							<RecordLink collection="insert_edges" :id="edge.id">Edge {{ edgeLabel(insert, edge) }}</RecordLink>
						</template>
					</template>

					<template v-if="pin" #title-actions><PinToggle :target="pin" :label="code" /></template>

					<template #rail>
						<RecordRail :kind="FOCUS_KIND_LABEL[focusKind]" :code="code" :title="railTitle" :facts="railFacts" :contents="contents">
							<template #kind-icon><v-icon name="handyman" x-small /></template>
							<template v-if="insert" #status><StateBadge :state="edge ? (edge.used ? 'used' : 'fresh') : insert.state" /></template>
							<template #actions>
								<v-button v-if="canUpdate !== false" icon small title="Edit" aria-label="Edit" @click="editing = true"><v-icon name="edit" small /><span class="sr-only">Edit</span></v-button>
								<v-button icon small secondary :to="studioTo" title="Data Studio" aria-label="Data Studio"><v-icon name="open_in_new" small /><span class="sr-only">Data Studio</span></v-button>
							</template>
						</RecordRail>
					</template>

					<!-- Outside every v-if that flips while moving inside a box: the stage and its WebGL context stay mounted. -->
					<ToolingStage :model="model" :focus="focus" :next-fresh="nextFresh" @select="onSelect" />

					<template v-if="focusKind === 'box'">
						<BoxPanels :model="model" :type="box?.insert_type_id ?? null" :next-fresh="nextFresh" :counts="edgeCounts" />
						<ToolingDetails :facts="details" :notes="notes" />
					</template>
					<template v-else-if="insert && edge">
						<ToolingDetails :facts="details" :notes="notes" :loading="!record" :warning="warning" />
						<EdgePanels :tests="tests" :operations="operations" />
					</template>
					<template v-else-if="insert">
						<ToolingDetails :facts="details" :notes="notes" :loading="!record" />
						<InsertPanels :insert="insert" :counts="edgeCounts" />
					</template>
					<LoadState v-else :loading="!record" error="This record is not in the box's list." />
				</RecordLayout>

				<EditDrawer v-model="editing" :collection="collection" :primary-key="id" :title="`Edit ${code}`" @saved="onSaved" />
			</template>

			<LoadState v-else loading :loading-text="`Loading ${FOCUS_NOUN[focusKind]}…`" />
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: -1px; padding: 0; border: 0; }
</style>
