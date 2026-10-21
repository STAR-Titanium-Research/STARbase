<script setup lang="ts">
/*
 * Column 2, the run: its code and quality in the lid; what is always visible (the sample, material, when,
 * on what, by whom, the mould and mass as recorded, the six peaks); then icon tabs for the statistics, the
 * operation detail and the recipe; "Open operation" pinned at the bottom.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import FastStatsTab from './FastStatsTab.vue';
import RunSummaryTab from './RunSummaryTab.vue';
import RunWindowActions from './RunWindowActions.vue';
import type { Trace } from './fastCache';
import { buildHeader, buildRecipe, type Quality } from './fastMeta';
import type { RunProfile, RunTab } from './profile';


const ALL_TABS: Array<{ id: RunTab; name: string; icon: string }> = [
	{ id: 'stats', name: 'Statistics', icon: 'bar_chart' },
	{ id: 'detail', name: 'Operation detail', icon: 'info' },
	{ id: 'recipe', name: 'Recipe', icon: 'science' },
];

const props = defineProps<{
	profile: RunProfile; tab: RunTab; code: string | null; quality: { level: Quality; label: string; hint: string } | null;
	detail: any | null; runData: any | null; trace: Trace | null; loading: boolean; message: string | null;
	zoomStart: number | null; zoomEnd: number | null; cursor: number | null; zoomTool: boolean; busy?: boolean;
}>();
const emit = defineEmits<{
	(e: 'update:tab', v: RunTab): void; (e: 'open-operation'): void; (e: 'open-recipe'): void; (e: 'open-sample'): void;
	(e: 'zoom', v: { start: number; end: number } | null): void; (e: 'hover', t: number | null): void;
	(e: 'run-changed', v: { resetView: boolean }): void;
}>();

const header = computed(() => buildHeader(props.detail));
const TABS = computed(() => ALL_TABS.filter((t) => props.profile.tabs.includes(t.id)));
const stats = computed(() => props.profile.buildStats(props.detail, props.runData));
const peaks = computed(() => stats.value.filter((s) => props.profile.peakLabels.includes(s.label)));
const mould = computed(() => stats.value.filter((s) => props.profile.factLabels.includes(s.label)));
const facts = computed(() => props.profile.headerFacts(props.detail));
const peaksNote = computed(() => props.profile.peaksNote ?? (peaks.value.some((p) => p.source === 'recorded') ? 'measured, or recorded' : 'measured from the trace'));
const rows = computed(() => props.profile.detailRows(props.detail, props.runData));
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
const noTrace = computed(() => props.profile.noTraceMessage(props.runData));
// a run with a log but no window has no figures yet: say how to get them
const summaryEmpty = computed(() => (props.profile.traceReady(props.runData)
	? 'No run window is set. Zoom the plots to the run, then use "Use this view as the run window".'
	: noTrace.value));

// Left and Right (and Home, End) move between the tabs, as a tab list does; the selected tab is the one in the tab order.
const tablist = ref<HTMLElement | null>(null);
function onTabKey(ev: KeyboardEvent) {
	const tabs = TABS.value;
	const at = tabs.findIndex((t) => t.id === props.tab);
	const to = ev.key === 'ArrowRight' ? (at + 1) % tabs.length : ev.key === 'ArrowLeft' ? (at + tabs.length - 1) % tabs.length : ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : -1;
	if (to < 0) return;
	ev.preventDefault();
	emit('update:tab', tabs[to].id);
	nextTick(() => (tablist.value?.querySelectorAll<HTMLElement>('[role=tab]')[to])?.focus());
}

// Keys 1-3 pick the tab, except while typing in a field.
function onKey(ev: KeyboardEvent) {
	const el = ev.target as HTMLElement | null;
	if (ev.ctrlKey || ev.metaKey || ev.altKey || el?.closest('input, textarea, select, [contenteditable]')) return;
	const i = Number(ev.key) - 1;
	if (Number.isInteger(i) && TABS.value[i]) emit('update:tab', TABS.value[i].id);
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
					<div v-for="[label, value] in facts" :key="label"><dt>{{ label }}</dt><dd>{{ value || '—' }}</dd></div>
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
				<RunWindowActions v-if="profile.setWindowFromView || profile.upload || profile.linkExisting" :profile="profile" :detail="detail" :run-data="runData" :trace="trace"
					:zoom-start="zoomStart" :zoom-end="zoomEnd" :busy="!!busy" @changed="emit('run-changed', $event)" />
			</div>
			<div ref="tablist" class="tabs" role="tablist" aria-label="Run details" @keydown="onTabKey">
				<button v-for="(t, i) in TABS" :id="`fd-tab-${t.id}`" :key="t.id" class="fd-tab" role="tab" :aria-selected="tab === t.id" :aria-controls="tab === t.id ? `fd-panel-${t.id}` : undefined"
					:tabindex="tab === t.id ? 0 : -1" :aria-label="t.name" :title="`${t.name} (${i + 1})`" @click="emit('update:tab', t.id)">
					<v-icon :name="t.icon" small />
				</button>
			</div>
			<div :id="`fd-panel-${tab}`" class="tabbody" role="tabpanel" :aria-labelledby="`fd-tab-${tab}`">
				<div v-if="message" class="fd-empty err" role="status">{{ message }}</div>
				<template v-if="tab === 'stats' && profile.summaryTiles">
					<RunSummaryTab :tiles="profile.summaryTiles(detail, runData)" :note="profile.summaryNote?.(runData) ?? null" :window="profile.windowLabel?.(runData) ?? null" :empty="summaryEmpty" />
				</template>
				<template v-else-if="tab === 'stats'">
					<FastStatsTab v-if="trace" :trace="trace" :detail="detail" :zoom-start="zoomStart" :zoom-end="zoomEnd" :cursor="cursor" :zoom-tool="zoomTool"
						@zoom="emit('zoom', $event)" @hover="emit('hover', $event)" />
					<div v-else-if="profile.traceReady(runData) && loading" class="fd-spin"><v-progress-circular indeterminate small /> loading trace…</div>
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
