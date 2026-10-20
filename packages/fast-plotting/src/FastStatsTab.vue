<script setup lang="ts">
/*
 * The Statistics tab of the run column: the phase bar (heating, hold, cooling), the figures of the run or
 * of the zoomed window, and the cumulative energy chart, which takes the height that is left.
 */
import { computed, ref } from 'vue';
import FastChart from './FastChart.vue';
import type { Trace } from './fastCache';
import { cumulativeEnergy, runStats, statsCsv } from './fastStats';

const props = defineProps<{
	trace: Trace; detail: any;
	zoomStart: number | null; zoomEnd: number | null;
	cursor: number | null; zoomTool: boolean;
}>();
const emit = defineEmits<{ (e: 'zoom', v: { start: number; end: number } | null): void; (e: 'hover', t: number | null): void }>();

const scope = ref<'run' | 'window'>('run');
const zoomed = computed(() => props.zoomStart != null || props.zoomEnd != null);
const t0 = computed(() => props.trace.time[0]);
const tEnd = computed(() => props.trace.time[props.trace.time.length - 1]);
// The window the figures cover: the shared zoom, when "Zoom window" is chosen and a plot is zoomed.
const win = computed(() => (scope.value === 'window' && zoomed.value ? { start: props.zoomStart ?? t0.value, end: props.zoomEnd ?? tEnd.value } : null));

const stats = computed(() => runStats(props.trace, {
	target: Number(props.detail?.fast_recipe_id?.target_temp_c) || null,
	massG: Number(props.detail?.sintering_mass_grams) || null,
	window: win.value,
}));
const energy = computed(() => cumulativeEnergy(props.trace));
const energySeries = computed(() => (energy.value ? [{ key: 'energy', label: 'Cumulative energy', unit: 'kWh', group: 'energy', values: energy.value.kwh }] : []));

const mins = (s: number) => `${(s / 60).toFixed(1)} min`;
const bar = computed(() => {
	const p = stats.value.phases;
	if (!p) return null;
	const [a, z] = [p.heating[0], p.cooling[1]];
	const at = (t: number) => `${Math.min(100, Math.max(0, ((t - a) / (z - a || 1)) * 100))}%`;
	const parts = [['Heating', p.heating, 'heat'], ['Hold', p.hold, 'hold'], ['Cooling', p.cooling, 'cool']] as const;
	const outline = win.value ? { left: at(win.value.start), width: `calc(${at(win.value.end)} - ${at(win.value.start)})` } : null;
	return { parts: parts.map(([label, span, tone]) => ({ label, tone, grow: Math.max(span[1] - span[0], 1), text: mins(span[1] - span[0]) })), outline, target: p.target };
});
// the figure the chart below is about
const keyTile = 'energy';

function exportCsv() {
	const scopeName = win.value ? `Zoom window ${(win.value.start / 60).toFixed(1)} to ${(win.value.end / 60).toFixed(1)} min` : 'Whole run';
	const url = URL.createObjectURL(new Blob([statsCsv(stats.value, scopeName)], { type: 'text/csv' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = `${props.detail?.pass_code || 'run'}-statistics${win.value ? '-window' : ''}.csv`;
	a.click();
	URL.revokeObjectURL(url);
}
</script>

<template>
	<div class="stats">
		<div class="title"><b>Statistics</b><span class="fd-dim">measured from the trace</span><span class="grow"></span><button class="fd-link" title="Download these figures as a CSV file" @click="exportCsv">CSV</button></div>
		<div class="row">
			<b>Phases</b>
			<div class="fd-seg" role="group" aria-label="Figures cover">
				<button :aria-pressed="!win" @click="scope = 'run'">Whole run</button>
				<button :aria-pressed="!!win" :disabled="!zoomed" :title="zoomed ? 'Figures for the zoomed range' : 'Zoom a plot to use a window'" @click="scope = 'window'">Zoom window</button>
			</div>
		</div>
		<div v-if="bar" class="phases" :title="`Hold: within 10 °C of ${Math.round(bar.target)} °C. Cooling: from the end of the hold to 200 °C.`">
			<div v-for="p in bar.parts" :key="p.label" class="phase" :class="p.tone" :style="{ flexGrow: p.grow }"><span>{{ p.label }}</span><b>{{ p.text }}</b></div>
			<i v-if="bar.outline" class="outline" :style="bar.outline"></i>
		</div>
		<div class="fd-tiles">
			<div v-for="t in stats.tiles" :key="t.key" class="fd-fig" :class="{ key: t.key === keyTile }">
				<span class="top"><span class="val">{{ t.value }}</span><span class="unit">{{ t.unit }}</span></span>
				<span class="lab">{{ t.label }}</span>
			</div>
		</div>
		<template v-if="energy">
			<div class="energy-head"><b>Energy</b><span class="fd-dim">cumulative over the whole run</span></div>
			<div class="chart">
				<FastChart :time="energy.t" :series="energySeries" :fill="true" :band="win" :zoom-tool="zoomTool" :cursor="cursor" @zoom="emit('zoom', $event)" @hover="emit('hover', $event)" />
			</div>
		</template>
	</div>
</template>

<style scoped>
.stats { display: flex; flex-direction: column; flex: 1 0 auto; gap: 8px; }
.title { display: flex; align-items: baseline; gap: 6px; font-size: var(--fs-md, 13px); }
.title .grow { flex: 1 1 auto; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.phases { position: relative; display: flex; gap: 2px; border-radius: 4px; overflow: hidden; }
.phase { display: flex; flex-direction: column; min-width: 0; padding: 2px 6px; font-size: var(--fs-xs, 11px); line-height: 1.25; white-space: nowrap; overflow: hidden; }
.phase.heat { background: color-mix(in srgb, var(--fd-accent) 18%, transparent); }
.phase.hold { background: color-mix(in srgb, var(--fd-accent) 38%, transparent); }
.phase.cool { background: color-mix(in srgb, var(--fd-accent) 8%, transparent); }
.phase b { font-variant-numeric: tabular-nums; }
.outline { position: absolute; top: 0; bottom: 0; box-sizing: border-box; border: 2px solid var(--theme--foreground); border-radius: 3px; pointer-events: none; }
.energy-head { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; font-size: var(--fs-md, 13px); }
.chart { flex: 1 1 140px; min-height: 84px; }
</style>
