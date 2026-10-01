<script setup lang="ts">
// Per-cluster summary for the Diagnostics Workbench. Rows come from clusterStats(workingSet);
// the colour chip matches DiagScatter's cluster overlay. Clicking a row selects that cluster
// across the workbench (emit 'select'); clicking the active row again clears it.
import { clusterColorCss } from './clusterPalette';
import type { ClusterRow } from './selection';

import { computed, ref } from 'vue';

const props = defineProps<{
	rows: ClusterRow[];
	activeId: number | null;
	/** One line naming which computation these rows describe — the framed full-resolution
	 *  view or the whole-cut bake. Without it the table and the Spatial map can disagree
	 *  with nothing on screen explaining why. */
	caption?: string;
}>();
const emit = defineEmits<{ (e: 'select', id: number | null): void }>();

// HDBSCAN finds however many clusters the data supports, and a low Min cluster size finds
// thousands. Rendering all of them produced a 2,608-row table that told the analyst nothing
// and buried the one number they needed (how many there are). Show the largest few, say how
// many there are in total, and name the parameter that changes it.
const HEAD = 12;
const expanded = ref(false);
const shown = computed(() => (expanded.value ? props.rows : props.rows.slice(0, HEAD)));
const realCount = computed(() => props.rows.filter((r) => r.id >= 0).length);
const hidden = computed(() => Math.max(0, props.rows.length - shown.value.length));

const fmt = (v: number | null, d = 2) => (v != null && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (f: number) => `${(f * 100).toFixed(f < 0.01 ? 2 : 1)}%`;

function onRow(id: number) {
	emit('select', props.activeId === id ? null : id);
}
</script>

<template>
	<div class="cluster-table">
		<div v-if="!rows.length" class="ct-empty">no clusters — enable HDBSCAN in the recipe</div>
		<template v-else>
		<p class="ct-caption">
			<strong>{{ realCount.toLocaleString() }}</strong> cluster{{ realCount === 1 ? '' : 's' }}
			<template v-if="caption"> · {{ caption }}</template> · click a row to isolate it
		</p>
		<p v-if="realCount > HEAD" class="ct-hint">
			HDBSCAN finds as many clusters as the data supports — it has no target count.
			Raise <em>Min cluster size</em> in the recipe for fewer, larger ones.
		</p>
		<table>
			<thead>
				<tr><th></th><th>cluster</th><th class="num">pts</th><th class="num">% cut</th>
					<th class="num">mean|z|</th><th class="num">max gi*</th><th class="num">r (mm)</th></tr>
			</thead>
			<tbody>
				<tr v-for="r in shown" :key="r.id"
					:class="{ active: r.id === activeId, noise: r.id < 0 }"
					@click="onRow(r.id)">
					<td><span class="chip" :style="{ background: clusterColorCss(r.id) }" /></td>
					<td>{{ r.id < 0 ? 'noise' : r.id }}</td>
					<td class="num">{{ r.n.toLocaleString() }}</td>
					<td class="num">{{ pct(r.fraction) }}</td>
					<td class="num">{{ fmt(r.meanAbsResidZ) }}</td>
					<td class="num">{{ fmt(r.maxGiStar) }}</td>
					<td class="num">{{ fmt(r.rMin, 1) }}–{{ fmt(r.rMax, 1) }}</td>
				</tr>
			</tbody>
		</table>
		<button v-if="hidden" class="ct-more" @click="expanded = true">
			show all {{ rows.length.toLocaleString() }} rows ({{ hidden.toLocaleString() }} hidden)
		</button>
		<button v-else-if="expanded && rows.length > HEAD" class="ct-more" @click="expanded = false">
			show only the {{ HEAD }} largest
		</button>
		</template>
	</div>
</template>

<style scoped>
.cluster-table { font-size: var(--fs-xs, 11px); overflow: auto; }
.ct-empty { padding: 10px 12px; color: var(--text-dim, #94a3b8); font-style: italic; }
.ct-caption { margin: 0; padding: 4px 8px 3px; font-size: var(--fs-xs, 11px); color: var(--text-dim, #94a3b8); font-style: italic; }
.ct-caption strong { color: var(--text, #e5e7eb); font-style: normal; font-variant-numeric: tabular-nums; }
.ct-hint { margin: 0; padding: 0 8px 5px; font-size: var(--fs-xs, 11px); line-height: 1.4; color: #fcd34d; }
.ct-hint em { font-style: normal; font-weight: 650; }
.ct-more {
	display: block; width: 100%; font: inherit; font-size: var(--fs-xs, 11px); cursor: pointer; padding: 4px 8px;
	color: var(--text-dim, #94a3b8); background: none; border: none;
	border-top: 1px solid var(--border, rgba(255,255,255,0.08));
}
.ct-more:hover { color: var(--accent, #38bdf8); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-weight: 600; font-size: var(--fs-xs, 11px); text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-dim, #94a3b8); padding: 4px 8px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.12)); }
td { padding: 4px 8px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.06)); color: var(--text, #e5e7eb); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: rgba(255,255,255,0.04); }
tbody tr.active { background: color-mix(in srgb, var(--accent, #38bdf8) 22%, transparent); }
tbody tr.noise td { color: var(--text-dim, #94a3b8); }
.chip { display: inline-block; width: 10px; height: 10px; border-radius: 3px; }
</style>
