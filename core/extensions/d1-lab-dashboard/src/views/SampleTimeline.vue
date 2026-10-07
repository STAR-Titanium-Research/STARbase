<template>
	<div class="d1-tl">
		<div v-if="loading" class="d1-tl-msg"><v-progress-circular indeterminate small /> Loading timeline…</div>
		<div v-else-if="error" class="d1-tl-msg d1-tl-err">{{ error }}</div>
		<div v-else-if="data" class="d1-tl-body">
			<section v-if="data.stock_origins.length || data.hidden.stock_origins">
				<h4>Raw stock</h4>
				<ul>
					<li v-for="s in data.stock_origins" :key="`${s.lot_id}|${s.via_sample_id}`" class="d1-tl-node d1-tl-stock">
						<router-link :to="recordRoute('raw_stock_lots', s.lot_id)">{{ s.lot_code || 'Stock lot' }}</router-link>
						<span class="d1-tl-sub">
							{{ [s.stock_type, s.supplier_name].filter(Boolean).join(' · ') }}
							<template v-if="s.mass_used_grams !== null"> · {{ s.mass_used_grams }} g used</template>
							<template v-if="s.via_sample_code && s.depth > 0"> · via {{ s.via_sample_code }}</template>
							<template v-if="s.through_hidden"> · via a sample you cannot see</template>
						</span>
					</li>
					<li v-if="data.hidden.stock_origins" class="d1-tl-hidden">{{ hiddenText(data.hidden.stock_origins) }}</li>
				</ul>
			</section>

			<section v-if="ancestors.length || data.hidden.ancestors">
				<h4>Ancestors</h4>
				<ul>
					<li v-if="data.hidden.ancestors" class="d1-tl-hidden">{{ hiddenText(data.hidden.ancestors) }}</li>
					<li
						v-for="a in ancestors"
						:key="a.sample_id"
						class="d1-tl-node"
						:style="{ marginLeft: `${Math.min(a.indent, 6) * 10}px` }"
					>
						<router-link :to="recordRoute('physical_samples', a.sample_id)">{{ a.sample_code || 'Sample' }}</router-link>
						<span class="d1-tl-sub">
							{{ [a.form, relation(a)].filter(Boolean).join(' · ') }}
							<template v-if="a.through_hidden"> · via a sample you cannot see</template>
						</span>
					</li>
				</ul>
			</section>

			<section>
				<h4>This sample</h4>
				<ul>
					<li class="d1-tl-node d1-tl-self">
						<router-link :to="recordRoute('physical_samples', data.sample.sample_id)">{{ data.sample.sample_code ?? 'This sample' }}</router-link>
						<span class="d1-tl-sub">{{ data.sample.form ?? '' }}</span>
					</li>
				</ul>
			</section>

			<section>
				<h4>Operations and tests ({{ data.events.length + data.hidden.events }})</h4>
				<ul>
					<li v-for="e in data.events" :key="e.id" class="d1-tl-node d1-tl-event">
						<span class="d1-tl-date">{{ formatDate(e.date) }}</span>
						<span class="d1-tl-kind" :class="`kind--${e.type}`">{{ e.type === 'test_session' ? 'Test' : 'Operation' }}</span>
						<router-link :to="recordRoute(e.collection, e.id)">{{ e.label ?? '—' }}</router-link>
						<span v-if="e.status" class="d1-tl-sub">{{ e.status }}</span>
						<span v-else-if="e.sequence !== null" class="d1-tl-sub">#{{ e.sequence }}</span>
					</li>
					<li v-if="data.hidden.events" class="d1-tl-hidden">{{ hiddenText(data.hidden.events) }}</li>
					<li v-if="!data.events.length && !data.hidden.events" class="d1-tl-empty">No operations or tests recorded.</li>
				</ul>
			</section>

			<section v-if="descendants.length || data.hidden.descendants">
				<h4>Descendants</h4>
				<ul>
					<li
						v-for="d in descendants"
						:key="d.sample_id"
						class="d1-tl-node"
						:style="{ marginLeft: `${Math.min(d.indent, 6) * 10}px` }"
					>
						<router-link :to="recordRoute('physical_samples', d.sample_id)">{{ d.sample_code || 'Sample' }}</router-link>
						<span class="d1-tl-sub">
							{{ [d.form, relation(d)].filter(Boolean).join(' · ') }}
							<template v-if="d.through_hidden"> · via a sample you cannot see</template>
						</span>
					</li>
					<li v-if="data.hidden.descendants" class="d1-tl-hidden">{{ hiddenText(data.hidden.descendants) }}</li>
				</ul>
			</section>

			<div v-for="t in truncatedNotes" :key="t" class="d1-tl-msg d1-tl-err">{{ t }}</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRequestGate, errorText, recordRoute } from '@d1/ui';

const props = defineProps<{ sampleId: string | null }>();
const api = useApi();
const gate = useRequestGate();

const data = ref<any | null>(null);
const loading = ref(false);
const error = ref('');

async function load() {
	const token = gate.begin();
	data.value = null;
	error.value = '';
	if (!props.sampleId) {
		loading.value = false;
		return;
	}
	loading.value = true;
	try {
		const res = await api.get(`/d1-trace/sample/${props.sampleId}`);
		if (!gate.isCurrent(token)) return;
		data.value = res.data;
	} catch (e: any) {
		if (!gate.isCurrent(token)) return;
		error.value =
			e?.response?.status === 404
				? 'This sample is not visible to you.'
				: `Could not load the timeline: ${errorText(e)}`;
	} finally {
		if (gate.isCurrent(token)) loading.value = false;
	}
}

watch(() => props.sampleId, load, { immediate: true });
onBeforeUnmount(() => gate.cancel());

// Oldest ancestors first, so the list reads stock -> grandparent -> parent -> this sample, each
// generation indented a step further in. `indent` is the generation offset from the top of the list.
const ancestors = computed(() => {
	const rows = [...(data.value?.ancestors ?? [])].sort((a: any, b: any) => b.depth - a.depth);
	const top = rows.length ? rows[0].depth : 0;
	return rows.map((a: any) => ({ ...a, indent: top - a.depth }));
});
const descendants = computed(() => (data.value?.descendants ?? []).map((d: any) => ({ ...d, indent: d.depth - 1 })));
// Each list is capped at 500 by the server: the nearest relatives, and the newest events.
const TRUNCATED_TEXT: Record<string, string> = {
	ancestors: 'Very long history: only the 500 nearest ancestors are shown.',
	descendants: 'Very long history: only the 500 nearest descendants are shown.',
	stock_origins: 'Very long history: only the 500 nearest raw stock lots are shown.',
	events: 'Very long history: only the newest 500 operations and tests are shown.',
};
const truncatedNotes = computed(() => Object.keys(data.value?.truncated ?? {}).map((k) => TRUNCATED_TEXT[k] ?? `Very long history: ${k.replace('_', ' ')} is cut short.`));

function relation(n: any): string {
	const parts: string[] = [];
	if (n.relationship_type) parts.push(String(n.relationship_type).replace(/_/g, ' '));
	if (n.fraction !== null && n.fraction !== undefined) parts.push(`fraction ${n.fraction}`);
	return parts.join(', ');
}

function hiddenText(n: number): string {
	return `${n} ${n === 1 ? 'item is' : 'items are'} not visible to you`;
}

function formatDate(d: string | null): string {
	if (!d) return 'undated';
	return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
</script>

<style scoped>
.d1-tl { overflow-y: auto; flex: 1; padding: 12px; font-size: 13px; }
.d1-tl-body { display: flex; flex-direction: column; gap: 14px; }
.d1-tl h4 {
	font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
	color: var(--theme--foreground-subdued, #64748b); margin: 0 0 6px;
}
.d1-tl ul { list-style: none; margin: 0; padding: 0 0 0 10px; border-left: 2px solid var(--theme--border-color, #e2e8f0); display: flex; flex-direction: column; gap: 5px; }
.d1-tl-node { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.d1-tl-node a { color: var(--theme--primary, #2563eb); text-decoration: none; font-weight: 600; }
.d1-tl-node a:hover { text-decoration: underline; }
.d1-tl-self a { font-size: 14px; }
.d1-tl-self { background: var(--theme--primary-background, #eef2ff); border-radius: 6px; padding: 4px 8px; margin-left: -8px; }
.d1-tl-sub { font-size: 11px; color: var(--theme--foreground-subdued, #64748b); }
.d1-tl-date { font-size: 11px; color: var(--theme--foreground-subdued, #64748b); min-width: 78px; }
.d1-tl-kind { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; }
.kind--manufacturing_operation { background: #e3f2fd; color: #1565c0; }
.kind--test_session { background: #f3e5f5; color: #6a1b9a; }
.d1-tl-hidden, .d1-tl-empty { font-size: 12px; font-style: italic; color: var(--theme--foreground-subdued, #64748b); }
.d1-tl-msg { display: flex; align-items: center; gap: 6px; padding: 12px; font-size: 12px; color: var(--theme--foreground-subdued, #64748b); }
.d1-tl-err { color: var(--theme--danger, #c62828); }
</style>
