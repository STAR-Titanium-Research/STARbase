<script setup lang="ts">
import { computed } from 'vue';
import { RecordLink, Section, StatusBadge, asRecord } from '@d1/ui';

// The samples an operation consumed (sample_id: the workpiece it acted on) and produced
// (output_sample_id: the new sample of an additive or FAST step). Machining modifies the input in
// place, so it often has only an input; a powder build has only an output.
const props = defineProps<{ input: unknown; output: unknown }>();

const rows = computed(() =>
	[
		{ role: 'Input', sample: asRecord(props.input), hidden: props.input && !asRecord(props.input) },
		{ role: 'Output', sample: asRecord(props.output), hidden: props.output && !asRecord(props.output) },
	].filter((r) => r.sample || r.hidden),
);
</script>

<template>
	<Section title="Input and output samples" :count="rows.length" :empty="!rows.length" empty-text="No sample is linked to this operation.">
		<ul class="rows">
			<li v-for="r in rows" :key="r.role" class="row">
				<span class="role" :class="r.role.toLowerCase()">{{ r.role }}</span>
				<template v-if="r.sample">
					<RecordLink collection="physical_samples" :id="r.sample.sample_id" class="code">
						{{ r.sample.sample_code || 'Sample' }}
					</RecordLink>
					<span v-if="r.sample.nickname" class="muted">{{ r.sample.nickname }}</span>
					<span v-if="r.sample.form" class="muted">{{ r.sample.form }}</span>
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
.rows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--theme--border-color-subdued); border-radius: 10px; }
.row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 10px 14px; font-size: 13.5px; }
.row + .row { border-top: 1px solid var(--theme--border-color-subdued); }
.role {
	min-width: 56px;
	text-align: center;
	font-size: 11px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	padding: 2px 10px;
	border-radius: 99px;
	color: var(--theme--foreground-subdued);
	background: var(--theme--background-normal);
}
.role.input { color: var(--theme--primary); background: var(--theme--primary-background); }
.role.output { color: var(--theme--success); background: var(--theme--success-background); }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.muted { color: var(--theme--foreground-subdued); }
.hint { margin: 8px 0 0; font-size: 12px; color: var(--theme--foreground-subdued); }
</style>
