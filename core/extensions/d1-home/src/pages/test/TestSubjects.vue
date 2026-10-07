<script setup lang="ts">
import { computed } from 'vue';
import { RecordLink, Section, StatusBadge, asRecord, humanise, type TestSubjects } from '@d1/ui';

// What the test was run on: the subjects of the test_sessions_subject junction (samples, or for
// tool tests an insert edge). `sample` is the derived primary sample (test_sessions.sample_id, kept
// equal to the junction's first sample by migration 139, or the only link of an older row), so it
// normally repeats the first junction sample; it is listed once, and still shows when the junction
// cannot be read.
const props = defineProps<{ sample: unknown; subjects: TestSubjects }>();

const samples = computed(() => {
	const out = [...props.subjects.samples];
	const direct = asRecord(props.sample);
	if (direct && !out.some((s) => s.sample_id === direct.sample_id)) out.unshift(direct);
	return out;
});
</script>

<template>
	<Section
		title="Subject"
		:count="samples.length + subjects.others.length"
		:empty="!samples.length && !subjects.others.length"
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
		</ul>
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
	color: var(--theme--primary);
	background: var(--theme--primary-background);
}
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.muted { color: var(--theme--foreground-subdued); }
</style>
