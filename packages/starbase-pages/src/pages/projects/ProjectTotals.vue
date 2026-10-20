<script setup lang="ts">
import { computed } from 'vue';
import { campaignStatusParts, type SectionState } from '@d1/ui';
import type { ProjectCounts } from './useProjectData';

// The Totals block of the Project hero: samples, operations done, tests done and campaigns as 2 x 2 big numbers, each with its planned count
// beneath ("12 planned"; the campaigns tile lists the open statuses instead). The counts follow the project rule (projectScope.ts), so they are
// plain text, not links: the index pages filter on the record's own project_id and a link could open a shorter list than the number clicked.
const props = defineProps<{ counts: SectionState<ProjectCounts> }>();

const num = (n: number) => n.toLocaleString('en-GB');
// A number that could not be read is a dash, never a wrong 0; while it loads it is left empty.
const big = (n: number | null) => (props.counts.loading ? '' : n === null ? '–' : num(n));
const c = computed(() => props.counts.data);
const tiles = computed(() => [
	{ key: 'samples', n: big(c.value.samples), label: c.value.samples === 1 ? 'sample' : 'samples', planned: c.value.samplesPlanned },
	{ key: 'operations', n: big(c.value.operations), label: 'operations done', planned: c.value.operationsPlanned },
	{ key: 'tests', n: big(c.value.tests), label: 'tests done', planned: c.value.testsPlanned },
]);
const campaigns = computed(() => ({ n: big(c.value.campaigns), label: c.value.campaigns === 1 ? 'campaign' : 'campaigns', parts: campaignStatusParts(c.value.campaignStatuses) }));
</script>

<template>
	<div class="totals-block">
		<h2 class="d1-sr-only">Totals</h2>
		<div class="totals">
			<div v-for="t in tiles" :key="t.key" class="total">
				<span class="n">{{ t.n }}</span>
				<span class="l">{{ t.label }}</span>
				<span class="sub"><template v-if="t.planned"><b>{{ num(t.planned) }}</b> planned</template></span>
			</div>
			<div class="total">
				<span class="n">{{ campaigns.n }}</span>
				<span class="l">{{ campaigns.label }}</span>
				<span class="sub"><template v-for="(p, i) in campaigns.parts" :key="p.label"><template v-if="i"> · </template><b>{{ p.n }}</b> {{ p.label }}</template></span>
			</div>
		</div>
		<p class="d1-note">Counts of the records you can see in this project.</p>
		<p v-if="counts.error" class="d1-note warn" role="alert">{{ counts.error }}</p>
	</div>
</template>

<style scoped>
.totals-block { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.totals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 28px; }
.total { display: flex; flex-direction: column; min-width: 0; padding-top: 8px; border-top: 1px solid var(--d1-line); }
.n { font-size: var(--fs-2xl, 22px); font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; min-height: 1.15em; }
.l { font-size: var(--fs-sm, 12px); font-weight: 600; }
.sub { font-size: var(--fs-xs, 11px); color: var(--d1-dim); font-variant-numeric: tabular-nums; min-height: 1.35em; }
.sub b { color: var(--theme--foreground); font-weight: 600; }
</style>
