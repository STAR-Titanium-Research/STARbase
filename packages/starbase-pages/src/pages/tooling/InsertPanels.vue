<script setup lang="ts">
import { computed } from 'vue';
import { DataTable, LoadState, RecordLink, Section, edgeLabel, edgeNotes, mismatchText, placementText, type SectionState, type ToolingInsert } from '@d1/ui';
import StateBadge from './StateBadge.vue';

// What an insert page shows under the stage: its edges, with state and position, each a link to the
// edge's own page. (Details and notes are ToolingDetails, placed by the page.)
const props = defineProps<{ insert: ToolingInsert; counts: SectionState<Map<string, number>> }>();

// "1 edge missing", "1 duplicate edge record ignored": what the insert's edge rows lack or repeat.
const notes = computed(() => edgeNotes(props.insert));
const rows = computed(() =>
	props.insert.edges.map((edge) => ({
		edge,
		label: edgeLabel(props.insert, edge),
		warning: edge.used ? '' : (props.counts.data.get(edge.id) ?? 0) > 0 ? mismatchText(props.counts.data.get(edge.id)!) : '',
	})),
);
</script>

<template>
	<Section id="edges" title="Edges" :count="insert.edges.length" :empty="!insert.edges.length" empty-text="No edges visible to you.">
		<LoadState v-if="counts.error" :error="counts.error" />
		<DataTable>
			<thead>
				<tr><th class="fit">Edge</th><th>Code</th><th>Position</th><th>State</th><th /></tr>
			</thead>
			<tbody>
				<tr v-for="r in rows" :key="r.edge.id">
					<td class="fit"><RecordLink collection="insert_edges" :id="r.edge.id">{{ r.label }}</RecordLink></td>
					<td class="mono">{{ r.edge.code }}</td>
					<td :class="{ dim: !r.edge.placement }">{{ placementText(r.edge) }}</td>
					<td><StateBadge :state="r.edge.used ? 'used' : 'fresh'" /></td>
					<td><span v-if="r.warning" class="d1-note warn">{{ r.warning }}</span></td>
				</tr>
			</tbody>
		</DataTable>
		<p v-for="n in notes" :key="n" class="d1-note warn">{{ n }}</p>
	</Section>
</template>
