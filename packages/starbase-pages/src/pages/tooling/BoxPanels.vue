<script setup lang="ts">
import { computed } from 'vue';
import {
	DataTable, FactList, LoadState, RecordLink, Section, StatTile, edgeLabel, edgeSummary, findInsert, freshWithHistory, insertLabel, mismatchText,
	STATE_LABEL, STATE_ORDER, stateCounts, typeFacts, type SectionState, type ToolingModel,
} from '@d1/ui';
import StateBadge from './StateBadge.vue';

// What a tool box page shows under the stage: how many inserts are in each state, the next fresh edge
// (the one to mount), the insert type's facts and the inserts. `type` is the box's expanded insert type.
const props = defineProps<{
	model: ToolingModel;
	type: any;
	nextFresh: { insertId: string; edgeId: string } | null;
	counts: SectionState<Map<string, number>>;
	manufacturer: SectionState<string>;
}>();

const tally = computed(() => stateCounts(props.model));
const facts = computed(() => typeFacts(props.type, props.model.geometry, props.manufacturer.data));

// The next fresh edge and, if tests or operations are linked to it, the warning.
const next = computed(() => {
	if (!props.nextFresh) return null;
	const insert = findInsert(props.model, props.nextFresh.insertId);
	const edge = insert?.edges.find((e) => e.id === props.nextFresh!.edgeId);
	if (!insert || !edge) return null;
	const { fresh, total } = edgeSummary(insert);
	return { insert, edge, fresh, total };
});
const mismatches = computed(() => freshWithHistory(props.model, props.counts.data));
const nextWarning = computed(() => {
	const hit = mismatches.value.find((m) => m.edge.id === next.value?.edge.id);
	return hit ? mismatchText(hit.count) : '';
});
// Per insert: how many of its edges are fresh, and how many of those have history.
const rows = computed(() =>
	props.model.inserts.map((insert) => ({
		insert,
		...edgeSummary(insert),
		suspect: mismatches.value.filter((m) => m.insert.id === insert.id).length,
	})),
);
</script>

<template>
	<Section id="state" title="Inserts by state" :count="model.inserts.length">
		<div class="tiles">
			<StatTile v-for="s in STATE_ORDER" :key="s" :label="STATE_LABEL[s]" :value="tally[s]" />
		</div>
	</Section>

	<Section id="next" title="Next fresh edge" :empty="!next" empty-text="No fresh edge left in this box.">
		<div v-if="next" class="next">
			<RecordLink collection="insert_edges" :id="next.edge.id" class="edge">Edge {{ edgeLabel(next.insert, next.edge) }}</RecordLink>
			<span class="where">
				on <RecordLink collection="cutting_inserts" :id="next.insert.id">{{ insertLabel(next.insert) }}</RecordLink>
				· {{ next.fresh }} of {{ next.total }} edges fresh
			</span>
			<p v-if="nextWarning" class="d1-note warn">{{ nextWarning }}</p>
		</div>
	</Section>

	<Section id="type" title="Insert type" :empty="!facts.some((f) => f.value !== null && f.value !== '')" empty-text="No insert type is set for this box.">
		<FactList :facts="facts" />
		<LoadState v-if="manufacturer.error" :error="manufacturer.error" />
	</Section>

	<Section id="inserts" title="Inserts" :count="model.inserts.length" :empty="!model.inserts.length" empty-text="No inserts visible to you.">
		<LoadState v-if="counts.error" :error="counts.error" />
		<DataTable>
			<thead>
				<tr><th class="fit">No.</th><th>Insert</th><th>State</th><th class="num">Fresh edges</th><th /></tr>
			</thead>
			<tbody>
				<tr v-for="r in rows" :key="r.insert.id">
					<td class="fit dim num">{{ r.insert.number ?? '' }}</td>
					<td><RecordLink collection="cutting_inserts" :id="r.insert.id" class="mono">{{ r.insert.code }}</RecordLink></td>
					<td><StateBadge :state="r.insert.state" /></td>
					<td class="num">{{ r.fresh }} of {{ r.total }}</td>
					<td class="dim">
						<span v-if="r.suspect" class="d1-note warn">{{ r.suspect }} marked fresh, but used</span>
					</td>
				</tr>
			</tbody>
		</DataTable>
	</Section>
</template>

<style scoped>
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.next { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.edge { font-size: var(--fs-xl, 18px); font-weight: 700; }
.where { font-size: var(--fs-md); color: var(--d1-dim); }
.next .d1-note { flex-basis: 100%; }
</style>
