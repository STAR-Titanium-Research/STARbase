<script setup lang="ts">
import { computed } from 'vue';
import ProgressBar from '../components/ProgressBar.vue';
import StatTile from '../components/StatTile.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { TEST_STATUS_ORDER } from '../status';
import type { Overview } from './rollup';

// Counts and progress bars of a campaign, from the roll-up (`buildOverview`).
const props = defineProps<{
	overview: Overview;
	/** The role may not read the force-analysis table. */
	forceHidden?: boolean;
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
	<div class="d1-progress-block">
		<div class="tiles">
			<StatTile label="Samples" :value="overview.counts.samples" icon="science" hint="Samples you can see in this campaign" />
			<StatTile label="Operations" :value="overview.counts.operations" icon="precision_manufacturing" hint="Operations you can see in this campaign" />
			<StatTile label="Test sessions" :value="overview.counts.tests" icon="biotech" hint="Test sessions you can see in this campaign" />
		</div>
		<p v-if="overview.counts.hiddenSamples" class="hidden-note">
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
.hidden-note { margin: 8px 0 0; font-size: 12.5px; font-style: italic; color: var(--theme--foreground-subdued); }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; }
.tiles > * { min-width: 140px; }
.bars { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; max-width: 560px; }
.row { display: flex; align-items: center; gap: 12px; }
.row > :last-child { flex: 1; }
.label { width: 130px; flex: none; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
.chip b { font-variant-numeric: tabular-nums; }
</style>
