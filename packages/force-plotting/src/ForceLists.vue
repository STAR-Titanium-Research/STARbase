<script setup lang="ts">
/*
 * Column 1: Samples -> Operations. Pick a sample, then its operations; the operations show a "Sample ... x"
 * chip while one is picked, with a search, "Metadata issues only" and "Show all". Folded (narrow pages) the
 * two panels hide behind a 44px tab that opens them over the operation column.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

export type OpCard = {
	id: string; row: any; code: string; sub: string;
	ready: { level: string; label: string; hint: string };
	issue: { level: string; count: number; hint: string } | null;
	latest: boolean;
};
type SampleItem = { sample_id: string; sample_code: string; nickname?: string; material?: string; ops: any[] };

const props = defineProps<{
	samples: SampleItem[]; ops: OpCard[]; selectedSampleId: string | null; filterSampleId: string | null; selectedRowId: string | null;
	opSearch: string; issuesOnly: boolean; issueCount: number; folded?: boolean; selectedCode?: string | null;
}>();
const emit = defineEmits<{
	(e: 'select-sample', s: SampleItem): void; (e: 'select-op', row: any): void;
	(e: 'update:filterSampleId', v: string | null): void; (e: 'update:opSearch', v: string): void; (e: 'update:issuesOnly', v: boolean): void;
}>();

const sampleSearch = ref('');
const shown = computed(() => {
	const q = sampleSearch.value.trim().toLowerCase();
	return q ? props.samples.filter((s) => (s.sample_code || '').toLowerCase().includes(q) || (s.nickname || '').toLowerCase().includes(q) || (s.material || '').toLowerCase().includes(q)) : props.samples;
});
const chipCode = computed(() => props.samples.find((s) => s.sample_id === props.filterSampleId)?.sample_code ?? '');
const filtered = computed(() => props.filterSampleId !== null || props.opSearch.trim() !== '' || props.issuesOnly);
function showAll() { emit('update:filterSampleId', null); emit('update:opSearch', ''); emit('update:issuesOnly', false); }
function pickOp(row: any) { open.value = false; emit('select-op', row); }

// folded: the tab opens the lists over the operation column; Escape or a click elsewhere closes them
const open = ref(false);
const root = ref<HTMLElement | null>(null);
function away(ev: Event) { if (open.value && root.value && !root.value.contains(ev.target as Node)) open.value = false; }
function esc(ev: KeyboardEvent) { if (ev.key === 'Escape') open.value = false; }
onMounted(() => { document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc); });
onBeforeUnmount(() => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); });
watch(() => props.folded, () => { open.value = false; });
</script>

<template>
	<div ref="root" class="lists fp-lists" :class="{ folded }">
		<button v-if="folded" class="fold fp-fold fp-panel" :aria-expanded="open" title="Samples and operations" @click="open = !open">
			<v-icon :name="open ? 'chevron_left' : 'chevron_right'" x-small />
			<span class="fold-text">Samples<template v-if="selectedCode"> › {{ selectedCode }}</template></span>
		</button>
		<div v-show="!folded || open" class="stack" :class="{ over: folded }">
			<section class="fp-panel part samples" aria-label="Samples">
				<header class="fp-lid"><span>Samples</span><span class="fp-chip">{{ shown.length }}</span></header>
				<div class="pad"><label class="fp-search"><v-icon name="search" x-small /><input v-model="sampleSearch" placeholder="Search samples" aria-label="Search samples" /></label></div>
				<div class="list">
					<button v-for="s in shown" :key="s.sample_id" class="fp-card" :class="{ active: selectedSampleId === s.sample_id }" :aria-current="selectedSampleId === s.sample_id || undefined" @click="emit('select-sample', s)">
						<span class="fp-code">{{ s.sample_code }}</span>
						<span class="fp-dim sub">{{ s.material || '—' }}<template v-if="s.nickname"> · {{ s.nickname }}</template></span>
						<span class="fp-chip count">{{ s.ops.length }} {{ s.ops.length === 1 ? 'op' : 'ops' }}</span>
					</button>
					<div v-if="!shown.length" class="fp-empty">No samples</div>
				</div>
			</section>
			<section class="fp-panel part operations" aria-label="Operations">
				<header class="fp-lid">
					<span>Operations</span><span class="fp-chip">{{ ops.length }}</span><span class="grow"></span>
					<button v-if="filtered" class="fp-btn" @click="showAll">Show all</button>
				</header>
				<div class="pad">
					<button v-if="filterSampleId !== null" class="fp-btn chip" title="Show the operations of every sample" @click="emit('update:filterSampleId', null)">
						<span class="fp-dim">Sample</span> <span class="fp-code">{{ chipCode }}</span> <v-icon name="close" x-small />
					</button>
					<label class="fp-search"><v-icon name="search" x-small /><input :value="opSearch" placeholder="Search operations" aria-label="Search operations" @input="emit('update:opSearch', ($event.target as HTMLInputElement).value)" /></label>
					<!-- Metadata Doctor filter. Separate from the FRM badge: this one is about whether the .mat and D1 agree. -->
					<label v-if="issueCount || issuesOnly" class="issues">
						<input type="checkbox" :checked="issuesOnly" @change="emit('update:issuesOnly', ($event.target as HTMLInputElement).checked)" />
						<span>Metadata issues only</span><span class="fp-chip">{{ issueCount }}</span>
					</label>
				</div>
				<div class="list">
					<button v-for="o in ops" :key="o.id" v-memo="[o.id === selectedRowId, o.code, o.sub, o.ready.label, o.issue?.count, o.latest]" class="fp-card" :class="{ active: o.id === selectedRowId }" :aria-current="o.id === selectedRowId || undefined" @click="pickOp(o.row)">
						<span class="fp-code">{{ o.code }}<span v-if="o.latest" class="fp-badge blue latest" title="The most recently saved recording">Latest</span></span>
						<span class="fp-dim sub">{{ o.sub }}</span>
						<span class="badges">
							<span class="fp-badge" :class="o.ready.level" :title="o.ready.hint">{{ o.ready.label }}</span>
							<span v-if="o.issue" class="fp-badge" :class="o.issue.level" :title="`Metadata: ${o.issue.hint}`">{{ o.issue.count }} {{ o.issue.count === 1 ? 'issue' : 'issues' }}</span>
						</span>
					</button>
					<div v-if="!ops.length" class="fp-empty">No operations</div>
				</div>
			</section>
		</div>
	</div>
</template>

<style scoped>
.lists { position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.stack { display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-height: 0; }
.part { flex: 1 1 0; }
.pad { display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 6px; flex: none; }
.chip { justify-content: flex-start; max-width: 100%; overflow: hidden; border-radius: 99px; }
.issues { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm, 12px); cursor: pointer; }
.issues input { margin: 0; cursor: pointer; accent-color: var(--fp-accent); }
.issues .fp-chip { margin-left: auto; }
.list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 0 0 4px; }
.fp-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 8px; align-items: center; text-align: left; flex: none; padding: 7px 12px 7px 10px; font: inherit; color: inherit; cursor: pointer;
	background: transparent; border: 0; border-left: 3px solid transparent; content-visibility: auto; contain-intrinsic-size: auto 70px; }
.fp-card:hover { background: var(--fp-tile); }
.fp-card.active { background: var(--fp-tint); border-left-color: var(--fp-accent); }
.fp-card .fp-code { font-size: var(--fs-md, 13px); overflow-wrap: anywhere; }
.fp-card .sub { grid-column: 1; font-size: var(--fs-sm, 12px); overflow-wrap: anywhere; }
.fp-card .count { grid-column: 2; grid-row: 1 / span 2; }
.fp-card .badges { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.latest { margin-left: 6px; vertical-align: middle; }

/* folded: a 44px tab, the lists open over the operation column */
.folded .fold { flex: 1 1 auto; align-items: center; justify-content: flex-start; gap: 6px; padding: 12px 0; cursor: pointer; font: inherit; color: inherit; width: 100%; }
.fold-text { writing-mode: vertical-rl; font-size: var(--fs-sm, 12px); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-height: 100%; }
.stack.over { position: absolute; z-index: 30; top: 0; bottom: 0; left: 0; width: 290px; padding: 8px; border-radius: 14px; background: var(--theme--background); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28); }
</style>
