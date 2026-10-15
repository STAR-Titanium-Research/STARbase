<script setup lang="ts">
import { computed } from 'vue';
import { RecordLink, Section, StatusBadge, asRecord, choiceLabel } from '@d1/ui';

// The samples an operation consumed (sample_id: the workpiece it acted on) and produced
// (output_sample_id: the new sample of an additive or FAST step). Machining modifies the input in
// place, so it often has only an input; a powder build has only an output.
//
// A sample the user may not read comes back as null, the same as no sample at all (row-level
// visibility, ADR-0011), so the page reads the raw keys once (`*Hidden`) to tell them apart.
const props = defineProps<{ input: unknown; output: unknown; inputHidden?: boolean; outputHidden?: boolean }>();

const rows = computed(() =>
	[
		{ role: 'Input', sample: asRecord(props.input), hidden: props.inputHidden || (props.input && !asRecord(props.input)) },
		{ role: 'Output', sample: asRecord(props.output), hidden: props.outputHidden || (props.output && !asRecord(props.output)) },
	].filter((r) => r.sample || r.hidden),
);
</script>

<template>
	<Section title="Samples in and out" :count="rows.length" :empty="!rows.length" empty-text="No sample is linked to this operation.">
		<ul class="rows">
			<li v-for="r in rows" :key="r.role" class="row">
				<span class="role" :class="r.role.toLowerCase()">{{ r.role }}</span>
				<template v-if="r.sample">
					<RecordLink collection="physical_samples" :id="r.sample.sample_id" class="code">
						{{ r.sample.sample_code || 'Sample' }}
					</RecordLink>
					<span v-if="r.sample.nickname" class="muted">{{ r.sample.nickname }}</span>
					<span v-if="r.sample.form" class="muted">{{ choiceLabel('geometry', r.sample.form) }}</span>
					<StatusBadge kind="sample" :value="r.sample.current_status" />
				</template>
				<span v-else class="muted">Not visible to you</span>
			</li>
		</ul>
		<p class="hint">
			Machining acts on the input in place. An additive or FAST step produces the output, which is
			recorded as derived from the input in the sample's lineage.
		</p>
	</Section>
</template>

<style scoped>
/* Rows of the panel itself: a role chip, the code, then what is known about the sample. */
.rows { list-style: none; margin: 0; padding: 0; }
.row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 7px 0; font-size: var(--fs-md); }
.row:first-child { padding-top: 0; }
.row + .row { border-top: 1px solid var(--d1-line); }
.role {
	min-width: 56px;
	text-align: center;
	font-size: var(--fs-xs);
	font-weight: 700;
	padding: 1px 8px;
	border-radius: 99px;
	color: var(--d1-dim);
	background: var(--theme--background-normal);
}
.role.input { color: var(--d1-accent, var(--theme--primary)); background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent); }
.role.output { color: var(--d1-ok); background: color-mix(in srgb, var(--theme--success) 18%, transparent); }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.muted { color: var(--d1-dim); }
.hint { margin: 8px 0 0; font-size: var(--fs-sm); color: var(--d1-dim); }
</style>
