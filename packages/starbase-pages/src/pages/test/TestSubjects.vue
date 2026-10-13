<script setup lang="ts">
import { computed } from 'vue';
import { RecordLink, Section, StatusBadge, asRecord, humanise, testSubjectCount, type TestSubjects } from '@d1/ui';

// What the test was run on: the subjects of the test_sessions_subject junction (samples, or for
// tool tests an insert edge). `sample` is the derived primary sample (test_sessions.sample_id, kept
// equal to the junction's first sample by migration 139, or the only link of an older row), so it
// normally repeats the first junction sample; it is listed once, and still shows when the junction
// cannot be read.
//
// A subject the user may not read (row-level visibility, ADR-0011) comes back as null, the same as
// no subject: `subjects.hidden` counts those junction rows, and `sampleHidden` says the primary
// sample column links to one (a raw-key read), so the page says "not visible" instead of "none".
const props = defineProps<{ sample: unknown; subjects: TestSubjects; sampleHidden?: boolean }>();

const samples = computed(() => {
	const out = [...props.subjects.samples];
	const direct = asRecord(props.sample);
	if (direct && !out.some((s) => s.sample_id === direct.sample_id)) out.unshift(direct);
	return out;
});
const hiddenCount = computed(() => Math.max(props.subjects.hidden, props.sampleHidden ? 1 : 0));
// The row count is the kit's (the page's "On this page" entry uses the same function).
const total = computed(() => testSubjectCount(props.sample, props.subjects, !!props.sampleHidden));
</script>

<template>
	<Section
		title="Subject"
		:count="total"
		:empty="total === 0"
		empty-text="No sample or other subject is recorded for this test."
	>
		<ul class="rows">
			<li v-for="s in samples" :key="s.sample_id" class="row">
				<span class="role">Sample</span>
				<RecordLink collection="physical_samples" :id="s.sample_id" class="code">{{ s.sample_code || 'Sample' }}</RecordLink>
				<span v-if="s.nickname" class="muted">{{ s.nickname }}</span>
				<span v-if="s.form" class="muted">{{ s.form }}</span>
				<StatusBadge kind="sample" :value="s.current_status" />
			</li>
			<li v-for="o in subjects.others" :key="o.collection + o.item" class="row">
				<span class="role">{{ humanise(o.collection.replace(/s$/, '')) }}</span>
				<RecordLink :collection="o.collection" :id="o.item" class="code">{{ o.label || o.item.slice(0, 8) }}</RecordLink>
			</li>
			<li v-if="hiddenCount" class="row">
				<span class="role">Sample</span>
				<span class="muted">Some subjects are not visible to you</span>
			</li>
		</ul>
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
	color: var(--d1-accent, var(--theme--primary));
	background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent);
}
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.muted { color: var(--d1-dim); }
</style>
