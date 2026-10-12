<script setup lang="ts">
import { computed } from 'vue';
import ProgressBar from '../components/ProgressBar.vue';
import StatTile from '../components/StatTile.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { TEST_STATUS_ORDER } from '../status';
import type { Overview } from './rollup';

// Counts and progress bars of a campaign, from the roll-up (`buildOverview`). `rail`: only the bars, bare
// and stacked, for the Campaign page's rail (its counts are rail facts there, and the hidden-samples
// note is the Samples fact's unit); the Data Studio form keeps the tiles and the boxed bars.
const props = defineProps<{
	overview: Overview;
	/** The role may not read the force-analysis table. */
	forceHidden?: boolean;
	/** Bars only, for the rail of a record page. */
	rail?: boolean;
	/** The force-analysis read failed for another reason (its error is shown by the lists). */
	forceFailed?: boolean;
}>();

const noForce = computed(() => props.forceHidden || props.forceFailed);
const statusChips = computed(() => {
	const by = props.overview.counts.testsByStatus;
	return Object.keys(by)
		.sort((a, b) => TEST_STATUS_ORDER.indexOf(a) - TEST_STATUS_ORDER.indexOf(b))
		.map((status) => ({ status, n: by[status] }));
});
const p = computed(() => props.overview.progress);
</script>

<template>
	<div class="d1-progress-block" :class="{ rail }">
		<div v-if="!rail" class="tiles">
			<StatTile label="Samples" :value="overview.counts.samples" icon="science" hint="Samples you can see in this campaign" />
			<StatTile label="Operations" :value="overview.counts.operations" icon="precision_manufacturing" hint="Operations you can see in this campaign" />
			<StatTile label="Test sessions" :value="overview.counts.tests" icon="biotech" hint="Test sessions you can see in this campaign" />
		</div>
		<p v-if="overview.counts.hiddenSamples && !rail" class="hidden-note">
			{{ overview.counts.hiddenSamples }} {{ overview.counts.hiddenSamples === 1 ? 'sample' : 'samples' }} in this campaign not visible to you
			(counted on the campaign card, not in the tiles).
		</p>
		<div class="bars">
			<div class="row">
				<span class="label">Force analysed</span>
				<ProgressBar
					:value="p.analysed"
					:max="p.forceOps"
					:label="forceHidden ? 'not visible to your role' : forceFailed ? 'could not load' : `${p.analysed} / ${p.forceOps}`"
					:title="`${p.analysed} of ${p.forceOps} machining operations analysed`"
				/>
			</div>
			<div v-if="!noForce" class="row">
				<span class="label">Diagnostics built</span>
				<ProgressBar :value="p.diagBuilt" :max="p.forceOps" />
			</div>
			<div class="row">
				<span class="label">Tests complete</span>
				<ProgressBar :value="p.testsComplete" :max="overview.counts.tests" title="Test sessions whose data is processed or analysed" />
			</div>
			<div v-if="statusChips.length" class="chips">
				<span v-for="c in statusChips" :key="c.status" class="chip"><b>{{ c.n }}</b><StatusBadge kind="test" :value="c.status" /></span>
			</div>
		</div>
	</div>
</template>

<style scoped>
.hidden-note { margin: 8px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
/* The tiles fill the row like the Project page's; the bars sit in a panel under them, side by
   side while there is room (stacked at half the page width they were mostly empty track). */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.bars {
	margin-top: 12px;
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
	gap: 8px 28px;
	padding: 10px 14px;
	background: var(--d1-surface, var(--theme--background));
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px);
	box-shadow: var(--d1-shadow, none);
}
.row { display: flex; align-items: center; gap: 12px; min-width: 0; }
.row > :last-child { flex: 1; min-width: 0; }
.label { flex: none; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.chips { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm, 12px); }
.chip b { font-variant-numeric: tabular-nums; }
/* In the rail (about 268px wide): no box inside the rail's own panel, one column, the label over its bar. */
.d1-progress-block.rail .bars { margin-top: 0; padding: 0; grid-template-columns: minmax(0, 1fr); background: none; border: 0; border-radius: 0; box-shadow: none; }
.d1-progress-block.rail .row { flex-direction: column; align-items: stretch; gap: 2px; }
.d1-progress-block.rail .row > :last-child { flex: none; }
</style>
