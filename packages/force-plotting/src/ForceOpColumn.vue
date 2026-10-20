<script setup lang="ts">
/*
 * Column 2, the operation: its code and FRM state in the lid; the sample, when it was recorded and on what
 * always visible; then icon tabs (Cut parameters, Display, Signal filters, Signal statistics, Cutting
 * metrics) over the one panel that fills the rest; "Save changes" and "Open" pinned at the bottom. The tabs
 * are a WAI-ARIA tab list: arrow keys move, number keys 1-5 pick (not while typing in a field).
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import ForceCutTab from './ForceCutTab.vue';
import ForceDisplayTab from './ForceDisplayTab.vue';
import ForceFiltersTab from './ForceFiltersTab.vue';
import ForceStatsTab from './ForceStatsTab.vue';
import ForceCuttingTab from './ForceCuttingTab.vue';
import { useForceCtx } from './forceCtx';
import { tabForNumberKey, tabTarget } from './forceLayout';

export type OpTab = 'cut' | 'display' | 'filters' | 'stats' | 'cutting';
const TABS: Array<{ id: OpTab; name: string; icon: string }> = [
	{ id: 'cut', name: 'Cut parameters', icon: 'content_cut' },
	{ id: 'display', name: 'Display', icon: 'contrast' },
	{ id: 'filters', name: 'Signal filters', icon: 'filter_alt' },
	{ id: 'stats', name: 'Signal statistics', icon: 'bar_chart' },
	{ id: 'cutting', name: 'Cutting metrics', icon: 'speed' },
];

const { detail, loadingDetail, opLabel, ready, sampleInfo, fmtDate, recordedText, machineText, openPanel, cutEdited, chainDirty, stagesOnCount,
	hasChanges, changeSummary, changesDialogOpen, openOpForm, openSampleForm } = useForceCtx();

// the dot of a tab marks an unsaved edit: the cut fields and operation record, an unsaved filter chain
const dotted = computed<Record<OpTab, boolean>>(() => ({ cut: !!cutEdited.value, display: false, filters: !!chainDirty.value, stats: false, cutting: false }));

const sampleRows = computed(() => {
	const s = sampleInfo.value;
	return s ? ([['Material', s.material], ['Nickname', s.nickname], ['Form', s.form], ['Owner', s.owner], ['Made', s.manufactured ? fmtDate.value(s.manufactured) : ''], ['Operations', s.ops]] as Array<[string, any]>)
		.filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]) : [];
});
const tablist = ref<HTMLElement | null>(null);
function pick(id: OpTab) { openPanel.value = id; }
function onTabKey(ev: KeyboardEvent) {
	const at = TABS.findIndex((t) => t.id === openPanel.value);
	const to = tabTarget(ev.key, at, TABS.length);
	if (to === null) return;
	ev.preventDefault();
	pick(TABS[to].id);
	nextTick(() => tablist.value?.querySelectorAll<HTMLElement>('[role=tab]')[to]?.focus());
}
function onKey(ev: KeyboardEvent) {
	const to = tabForNumberKey(ev, TABS.length);
	if (to !== null) pick(TABS[to].id);
}
// this page is kept alive: the keys are only ours while it is showing
const listen = () => window.addEventListener('keydown', onKey);
const unlisten = () => window.removeEventListener('keydown', onKey);
onMounted(listen); onActivated(listen); onDeactivated(unlisten); onBeforeUnmount(unlisten);
</script>

<template>
	<section class="fp-panel col" :class="{ switching: loadingDetail }" aria-label="Operation" :aria-busy="loadingDetail">
		<header class="fp-lid">
			<span class="fp-code code">{{ detail ? opLabel : 'Operation' }}</span>
			<span v-if="detail && ready" class="fp-badge" :class="ready.level" :title="ready.hint">{{ ready.label }}</span>
		</header>
		<div v-if="!detail" class="fp-empty">
			<div v-if="loadingDetail" class="fp-spin"><v-progress-circular indeterminate small /> loading…</div>
			<template v-else>Select an operation</template>
		</div>
		<div v-if="!detail && !loadingDetail && sampleInfo" class="ident">
			<div class="fp-pg"><span>Sample</span><span class="v"><span class="fp-code">{{ sampleInfo.sample_code }}</span><button class="fp-link" title="Open the sample record" @click="openSampleForm">Sample ↗</button></span></div>
			<div v-for="r in sampleRows" :key="r[0]" class="fp-pg"><span>{{ r[0] }}</span><span class="v">{{ r[1] }}</span></div>
		</div>
		<template v-else>
			<div class="ident">
				<div class="fp-pg"><span>Sample</span><span class="v"><span class="fp-code">{{ sampleInfo?.sample_code || '—' }}</span><button v-if="sampleInfo?.id" class="fp-link" title="Open the sample record" @click="openSampleForm">Sample ↗</button></span></div>
				<div class="fp-pg"><span>Recorded</span><span class="v">{{ recordedText }}</span></div>
				<div class="fp-pg"><span>Machine</span><span class="v">{{ machineText }}</span></div>
			</div>
			<div ref="tablist" class="fp-tabs" role="tablist" aria-label="Operation details" @keydown="onTabKey">
				<button v-for="(t, i) in TABS" :id="`fp-tab-${t.id}`" :key="t.id" class="fp-tab" role="tab" :aria-selected="openPanel === t.id" :aria-controls="openPanel === t.id ? `fp-panel-${t.id}` : undefined"
					:tabindex="openPanel === t.id ? 0 : -1" :aria-label="t.name" :title="`${t.name} (${i + 1})`" @click="pick(t.id)">
					<v-icon :name="t.icon" small />
					<span v-if="t.id === 'filters' && stagesOnCount" class="num" :title="`${stagesOnCount} filter stage${stagesOnCount === 1 ? '' : 's'} on`">{{ stagesOnCount }}</span>
					<span v-if="dotted[t.id]" class="dot" title="Unsaved changes"></span>
				</button>
			</div>
			<div :id="`fp-panel-${openPanel}`" class="body" role="tabpanel" :aria-labelledby="`fp-tab-${openPanel}`" tabindex="0" :inert="loadingDetail">
				<ForceCutTab v-if="openPanel === 'cut'" />
				<ForceDisplayTab v-else-if="openPanel === 'display'" />
				<ForceFiltersTab v-else-if="openPanel === 'filters'" />
				<ForceStatsTab v-else-if="openPanel === 'stats'" />
				<ForceCuttingTab v-else-if="openPanel === 'cutting'" />
			</div>
			<footer class="foot" :inert="loadingDetail">
				<button class="fp-btn save" :class="{ primary: hasChanges }" :disabled="!hasChanges" :title="hasChanges ? 'Review and save the edits to the operation record and the crop' : 'Nothing to save'" @click="changesDialogOpen = true">
					Save <template v-if="hasChanges && changeSummary.length">{{ changeSummary.length }} {{ changeSummary.length === 1 ? 'change' : 'changes' }}…</template><template v-else>changes</template>
				</button>
				<button class="fp-btn open" title="Open the operation record" @click="openOpForm">Open <v-icon name="open_in_new" x-small /></button>
			</footer>
		</template>
	</section>
</template>

<style scoped>
.col { min-height: 0; }
.col.switching .body { opacity: 0.45; pointer-events: none; transition: opacity 0.12s; }
.code { font-size: var(--fs-md, 13px); overflow-wrap: anywhere; }
.ident { flex: none; padding: 4px 12px 8px; }
.ident .fp-pg:last-child { border-bottom: 0; }
.body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 12px; }
.body:focus-visible { outline: 2px solid var(--fp-accent); outline-offset: -2px; }
.foot { flex: none; display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--fp-line); background: var(--fp-tile); }
.foot .save { flex: 1 1 auto; height: 32px; }
.foot .open { height: 32px; }
</style>
