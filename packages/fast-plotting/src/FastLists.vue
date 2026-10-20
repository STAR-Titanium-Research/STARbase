<script setup lang="ts">
/*
 * Column 1: Samples -> Runs. Pick a sample, then its runs; the runs show a "Sample ... x" chip while one is
 * picked, with a search and "Show all". Folded (narrow pages) the two panels hide behind a 44px tab that
 * opens them over the run column.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { NO_SAMPLE, filterRuns, filterSamples, groupBySample, sampleKeyOf, type ListRun } from './fastSamples';

const props = defineProps<{ rows: ListRun[]; selectedId: string | null; sample: string | null; folded?: boolean }>();
const emit = defineEmits<{ (e: 'update:sample', v: string | null): void; (e: 'select', row: ListRun): void }>();

// The searches run after typing settles, not per keystroke: the list can hold 10k runs.
function settled(source: Ref<string>, ms = 160): Ref<string> {
	const out = ref('');
	let timer = 0;
	watch(source, (v) => { clearTimeout(timer); timer = window.setTimeout(() => { out.value = v; }, ms); });
	onBeforeUnmount(() => clearTimeout(timer));
	return out;
}
const sampleRaw = ref(''), runRaw = ref('');
const sampleQuery = settled(sampleRaw), runQuery = settled(runRaw);

const groups = computed(() => groupBySample(props.rows));
const samples = computed(() => filterSamples(groups.value, sampleQuery.value));
const runs = computed(() => filterRuns(props.rows, props.sample, runQuery.value));
const selected = computed(() => props.rows.find((r) => r.id === props.selectedId) ?? null);
// the sample that is picked, or else the one the open run belongs to
const current = computed(() => props.sample ?? (selected.value ? sampleKeyOf(selected.value) : null));
const chipLabel = computed(() => (props.sample === NO_SAMPLE ? 'No sample' : props.sample));
const filtered = computed(() => props.sample !== null || runQuery.value.trim() !== '');

function pickSample(key: string) { emit('update:sample', props.sample === key ? null : key); }
function showAll() { emit('update:sample', null); runRaw.value = ''; runQuery.value = ''; }
function pickRun(r: ListRun) { open.value = false; emit('select', r); }

const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const meta = (r: ListRun) => [fmtDate(r.operation_date), r.sintering_max_temp_celsius ? `${Math.round(r.sintering_max_temp_celsius)} °C` : '', r.sintering_max_force_kn ? `${+Number(r.sintering_max_force_kn).toFixed(1)} kN` : '']
	.filter(Boolean).join(' · ');

// folded: the tab opens the lists over the run column; Escape or a click elsewhere closes them
const open = ref(false);
const root = ref<HTMLElement | null>(null);
function away(ev: Event) { if (open.value && root.value && !root.value.contains(ev.target as Node)) open.value = false; }
function esc(ev: KeyboardEvent) { if (ev.key === 'Escape') open.value = false; }
onMounted(() => { document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc); });
onBeforeUnmount(() => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); });
watch(() => props.folded, () => { open.value = false; });
</script>

<template>
	<div ref="root" class="lists" :class="{ folded }">
		<button v-if="folded" class="fold-tab fd-panel" :aria-expanded="open" title="Samples and runs" @click="open = !open">
			<v-icon :name="open ? 'chevron_left' : 'chevron_right'" x-small />
			<span class="fold-text">Samples<template v-if="selected"> › {{ selected.pass_code }}</template></span>
		</button>
		<div v-show="!folded || open" class="stack" :class="{ over: folded }">
			<section class="fd-panel part" aria-label="Samples">
				<header class="fd-lid"><span>Samples</span><span class="fd-chip">{{ groups.length }}</span></header>
				<div class="pad"><label class="fd-search"><v-icon name="search" x-small /><input v-model="sampleRaw" placeholder="Search samples" aria-label="Search samples" /></label></div>
				<div class="list">
					<button v-for="g in samples" :key="g.key" class="fd-card" :class="{ active: g.key === current }" :aria-current="g.key === current || undefined" @click="pickSample(g.key)">
						<span class="fd-code">{{ g.code }}</span>
						<span class="fd-dim sub">{{ g.sub || '—' }}</span>
						<span class="fd-chip count">{{ g.runs }} {{ g.runs === 1 ? 'run' : 'runs' }}</span>
					</button>
					<div v-if="!samples.length" class="fd-empty">No samples</div>
				</div>
			</section>
			<section class="fd-panel part" aria-label="Runs">
				<header class="fd-lid">
					<span>Runs</span><span class="fd-chip">{{ runs.length }}</span><span class="grow"></span>
					<button v-if="filtered" class="fd-btn" @click="showAll">Show all</button>
				</header>
				<div class="pad">
					<button v-if="sample !== null" class="fd-btn chip" :title="`Show the runs of every sample`" @click="emit('update:sample', null)">
						<span class="fd-dim">Sample</span> <span class="fd-code">{{ chipLabel }}</span> <v-icon name="close" x-small />
					</button>
					<label class="fd-search"><v-icon name="search" x-small /><input v-model="runRaw" placeholder="Search code / recipe" aria-label="Search runs by code or recipe" /></label>
				</div>
				<div class="list">
					<button v-for="r in runs" :key="r.id" v-memo="[r.id === selectedId]" class="fd-card" :class="{ active: r.id === selectedId }" :aria-current="r.id === selectedId || undefined" @click="pickRun(r)">
						<span class="fd-code">{{ r.pass_code || '—' }}</span>
						<span class="fd-dim sub">{{ meta(r) }}</span>
						<span class="fd-badge badge" :class="r.quality.level" :title="r.quality.hint">{{ r.quality.label }}</span>
					</button>
					<div v-if="!runs.length" class="fd-empty">No runs</div>
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
.list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 0 0 4px; }
.fd-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 8px; align-items: center; text-align: left; flex: none; padding: 7px 12px 7px 10px; font: inherit; color: inherit; cursor: pointer;
	background: transparent; border: 0; border-left: 3px solid transparent; content-visibility: auto; contain-intrinsic-size: auto 52px; }
.fd-card:hover { background: var(--fd-tile); }
.fd-card.active { background: var(--fd-tint); border-left-color: var(--fd-accent); }
.fd-card .fd-code { font-size: var(--fs-md, 13px); overflow: hidden; text-overflow: ellipsis; }
.fd-card .sub { grid-column: 1; font-size: var(--fs-sm, 12px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd-card .count { grid-column: 2; grid-row: 1 / span 2; }
.fd-card .badge { grid-column: 1; justify-self: start; margin-top: 3px; }

/* folded: a 44px tab, the lists open over the run column */
.folded .fold-tab { flex: 1 1 auto; align-items: center; justify-content: flex-start; gap: 6px; padding: 12px 0; cursor: pointer; font: inherit; color: inherit; width: 100%; }
.fold-text { writing-mode: vertical-rl; font-size: var(--fs-sm, 12px); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-height: 100%; }
.stack.over { position: absolute; z-index: 30; top: 0; bottom: 0; left: 0; width: 290px; padding: 8px; border-radius: 14px; background: var(--theme--background); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28); }
</style>
