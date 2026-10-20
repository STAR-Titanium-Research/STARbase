<script setup lang="ts">
/*
 * Column 2, the run: its code and quality in the lid; what is always visible (the sample, material, when,
 * on what, by whom, the mould and mass as recorded, the six peaks); then icon tabs for the statistics, the
 * operation detail and the recipe; "Open operation" pinned at the bottom.
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import FastStatsTab from './FastStatsTab.vue';
import type { Trace } from './fastCache';
import { CYCLE_LABELS, MOULD_LABELS, PEAK_LABELS, buildDetailRows, buildHeader, buildRecipe, buildStats, type Quality } from './fastMeta';

export type RunTab = 'stats' | 'detail' | 'recipe';
const TABS: Array<{ id: RunTab; name: string; icon: string }> = [
	{ id: 'stats', name: 'Statistics', icon: 'bar_chart' },
	{ id: 'detail', name: 'Operation detail', icon: 'info' },
	{ id: 'recipe', name: 'Recipe', icon: 'science' },
];

const props = defineProps<{
	tab: RunTab; code: string | null; quality: { level: Quality; label: string; hint: string } | null;
	detail: any | null; fastRun: any | null; trace: Trace | null; loading: boolean; message: string | null;
	zoomStart: number | null; zoomEnd: number | null; cursor: number | null; zoomTool: boolean;
}>();
const emit = defineEmits<{
	(e: 'update:tab', v: RunTab): void; (e: 'open-operation'): void; (e: 'open-recipe'): void; (e: 'open-sample'): void;
	(e: 'zoom', v: { start: number; end: number } | null): void; (e: 'hover', t: number | null): void;
}>();

const header = computed(() => buildHeader(props.detail));
const peaks = computed(() => buildStats(props.detail, props.fastRun, PEAK_LABELS));
const mould = computed(() => buildStats(props.detail, props.fastRun, MOULD_LABELS));
const peaksNote = computed(() => (peaks.value.some((p) => p.source === 'recorded') ? 'measured, or recorded' : 'measured from the trace'));
const rows = computed(() => buildDetailRows(props.detail, props.fastRun));
const recipe = computed(() => buildRecipe(props.detail));
const recipeRows = computed(() => {
	const r = recipe.value;
	if (!r) return [];
	const all: Array<[string, string | null]> = [
		['Machine', r.machine ? `FCT HP D ${r.machine}` : null], ['Program #', r.programNr ?? null], ['Target temp', r.tempC ? `${r.tempC} °C` : null],
		['Target force', r.forceKn ? `${r.forceKn} kN` : null], ['Hold time', r.holdMin ? `${r.holdMin} min` : null], ['Group', r.group ?? null], ['Source', r.source ?? null],
	];
	return all.filter(([, v]) => v !== null && v !== '').map(([label, value]) => ({ label, value: String(value), mono: label === 'Source' }));
});
const noTrace = computed(() => {
	const st = props.fastRun?.status;
	return st === 'pending' || st === 'processing' ? 'The trace is being imported.' : st === 'error' ? 'The trace import failed.' : 'No trace was imported for this run.';
});

// Keys 1-3 pick the tab, except while typing in a field.
function onKey(ev: KeyboardEvent) {
	const el = ev.target as HTMLElement | null;
	if (ev.ctrlKey || ev.metaKey || ev.altKey || el?.closest('input, textarea, select, [contenteditable]')) return;
	const i = Number(ev.key) - 1;
	if (Number.isInteger(i) && TABS[i]) emit('update:tab', TABS[i].id);
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
	<section class="fd-panel col" aria-label="Run">
		<header class="fd-lid">
			<span class="fd-code">{{ code || 'Run' }}</span>
			<span v-if="quality" class="fd-badge" :class="quality.level" :title="quality.hint">{{ quality.label }}</span>
		</header>
		<div v-if="!detail" class="fd-empty">
			<div v-if="loading" class="fd-spin"><v-progress-circular indeterminate small /> loading…</div>
			<template v-else>{{ message || 'Select a run' }}</template>
		</div>
		<template v-else>
			<div class="info">
				<div class="ident">
					<div class="who"><span class="fd-code">{{ header.sampleCode || '—' }}</span><button v-if="header.sampleId" class="fd-link" title="Open the sample record" @click="emit('open-sample')">Sample ↗</button></div>
					<div v-if="header.material" class="fd-dim">{{ header.material }}</div>
				</div>
				<dl class="facts">
					<div><dt>Date</dt><dd>{{ header.date || '—' }}</dd></div>
					<div><dt>Machine</dt><dd>{{ header.machine || '—' }}</dd></div>
					<div><dt>Operator</dt><dd>{{ header.operator || '—' }}</dd></div>
					<div><dt>Atmosphere</dt><dd>{{ header.atmosphere || '—' }}</dd></div>
					<div v-for="m in mould" :key="m.label"><dt>{{ m.label }}</dt><dd>{{ m.value }} {{ m.unit }}<span class="fd-tag">recorded</span></dd></div>
				</dl>
				<template v-if="peaks.length">
					<div class="head"><b>Peaks</b><span class="fd-dim">{{ peaksNote }}</span></div>
					<div class="fd-tiles">
						<div v-for="p in peaks" :key="p.label" class="fd-fig">
							<span class="top"><span class="val">{{ p.value }}</span><span class="unit">{{ p.unit }}</span></span>
							<span class="lab">{{ p.label }}<span v-if="p.source === 'recorded'" class="fd-tag">recorded</span></span>
						</div>
					</div>
				</template>
			</div>
			<div class="tabs" role="tablist" aria-label="Run details">
				<button v-for="(t, i) in TABS" :key="t.id" class="fd-tab" role="tab" :aria-selected="tab === t.id" :aria-label="t.name" :title="`${t.name} (${i + 1})`" @click="emit('update:tab', t.id)">
					<v-icon :name="t.icon" small />
				</button>
			</div>
			<div class="tabbody" role="tabpanel">
				<div v-if="message" class="fd-empty err" role="status">{{ message }}</div>
				<template v-if="tab === 'stats'">
					<FastStatsTab v-if="trace" :trace="trace" :detail="detail" :zoom-start="zoomStart" :zoom-end="zoomEnd" :cursor="cursor" :zoom-tool="zoomTool"
						@zoom="emit('zoom', $event)" @hover="emit('hover', $event)" />
					<div v-else-if="fastRun?.status === 'done' && loading" class="fd-spin"><v-progress-circular indeterminate small /> loading trace…</div>
					<div v-else class="fd-empty">{{ noTrace }}</div>
				</template>
				<template v-else-if="tab === 'detail'">
					<div class="title"><b>Operation detail</b><span class="fd-dim">from the operation record</span><span class="grow"></span><button class="fd-link" @click="emit('open-operation')">Open ↗</button></div>
					<div v-for="r in rows" :key="r.label" class="pg"><span class="fd-dim">{{ r.label }}</span><span class="v">{{ r.value }}<span v-if="r.tag" class="fd-tag">{{ r.tag }}</span></span></div>
					<div v-if="!rows.length" class="fd-empty">Nothing more is recorded.</div>
				</template>
				<template v-else>
					<template v-if="recipe">
						<div class="title"><b>Recipe</b><span class="fd-dim">FCT program</span><span class="grow"></span><button class="fd-link" @click="emit('open-recipe')">Open ↗</button></div>
						<div class="fd-code rname">{{ recipe.name }}</div>
						<div v-for="r in recipeRows" :key="r.label" class="pg"><span class="fd-dim">{{ r.label }}</span><span class="v" :class="{ 'fd-code': r.mono, src: r.mono }">{{ r.value }}</span></div>
					</template>
					<div v-else class="fd-empty">No recipe is recorded for this run.</div>
				</template>
			</div>
			<footer class="foot"><button class="fd-btn open" title="Open the operation record" @click="emit('open-operation')">Open operation <v-icon name="open_in_new" x-small /></button></footer>
		</template>
	</section>
</template>

<style scoped>
.col { min-height: 0; }
.info { flex: none; display: flex; flex-direction: column; gap: 10px; padding: 12px; }
.who { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.who .fd-code { font-size: var(--fs-md, 13px); }
.ident .fd-dim { font-size: var(--fs-sm, 12px); }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; margin: 0; }
.facts > div { padding: 4px 0 5px; border-top: 1px solid var(--fd-line); min-width: 0; }
.facts dt { font-size: var(--fs-xs, 11px); color: var(--fd-dim); }
.facts dd { margin: 0; font-weight: 650; font-size: var(--fs-md, 13px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head { display: flex; align-items: baseline; gap: 6px; font-size: var(--fs-sm, 12px); }
.tabs { flex: none; display: flex; border-top: 1px solid var(--fd-line); border-bottom: 1px solid var(--fd-line); background: var(--fd-tile); }
.fd-tab { flex: 1 1 0; display: grid; place-items: center; height: 40px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--fd-dim); cursor: pointer; }
.fd-tab:hover { color: var(--theme--foreground); }
.fd-tab[aria-selected='true'] { background: var(--fd-surface); border-bottom-color: var(--theme--foreground); color: var(--theme--foreground); }
.tabbody { flex: 1 1 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; }
.title { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; font-size: var(--fs-md, 13px); }
.title .grow { flex: 1 1 auto; }
.pg { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 31px; box-sizing: border-box; border-bottom: 1px solid var(--fd-line); font-size: var(--fs-md, 13px); }
.pg .v { font-weight: 650; text-align: right; min-width: 0; overflow-wrap: anywhere; }
.pg .v.src { font-size: var(--fs-xs, 11px); }
.rname { font-size: var(--fs-md, 13px); margin-bottom: 4px; overflow-wrap: anywhere; }
.err { color: var(--theme--danger); }
.foot { flex: none; padding: 10px 12px; border-top: 1px solid var(--fd-line); background: var(--fd-tile); }
.open { width: 100%; height: 32px; }
</style>
