<script setup lang="ts">
/*
 * Tab 3, Signal filters: the combined and per-stage frequency response (drag a cut-off or notch to edit
 * it) above the stage rows, both editing the same working chain. "Preview on the Lite map and FFT" draws the filtered
 * signal over the raw one (side by side in the Lite map, filtered spectrum in FFT) while you tune;
 * "Apply" keeps the chain as the operation's default (Lite recomputes it live), "Bake all" reprocesses
 * every output on the host.
 */
import { computed } from 'vue';
import FilterResponse from './FilterResponse.vue';
import { chainActive, cloneChain } from './filterChain';
import { useForceCtx } from './forceCtx';

const { detail, liveOn, workChain, cacheMeanRpm, previewOn, chainDirty, savedChain, bakedChain, appliedLight, filterBusy, filterErr, filterSkipped,
	profiles, applyProfile, saveProfile, applyFilter, bakeFilters, clearFilter, baking, bakeBlocked } = useForceCtx();
const nyquist = computed(() => (Number(detail.value?.sample_rate) || 25600) / 2);
function resetChain() { workChain.value = cloneChain(savedChain.value); }
function toggleHarmonic(h: number, on: boolean) {
	const cur: number[] = workChain.value.notch.harmonics;
	workChain.value.notch.harmonics = (on ? [...cur, h] : cur.filter((x) => x !== h)).sort();
}
</script>

<template>
	<div class="fp-title">
		<b>Signal filters</b><span class="fp-dim">applied to charts and Lite FRM</span><span class="grow"></span>
		<span v-if="bakedChain" class="fp-badge green" title="This op's outputs are baked with a filter chain">baked</span>
		<span v-else-if="appliedLight" class="fp-badge blue" title="Saved as this op's default — Lite recomputes it live; Full & FRM PNG stay raw until you Bake">applied · Lite</span>
		<button v-if="chainDirty" class="fp-link" title="Back to the saved chain" @click="resetChain">Reset</button>
	</div>
	<div v-if="!detail.live_cache_file" class="fp-empty">No signal cache — reprocess this op to enable filtering</div>
	<template v-else>
		<FilterResponse v-model:chain="workChain" :nyquist="nyquist" :rpm="cacheMeanRpm" />

		<div class="stage"><label class="chk"><input v-model="workChain.despike.on" class="tog" type="checkbox" /> Despike</label>
			<span class="args"><template v-if="workChain.despike.on"><input v-model.number="workChain.despike.window" type="number" min="3" step="2" title="Window (odd)" aria-label="Despike window" /><input v-model.number="workChain.despike.sigma" type="number" min="1" step="0.5" title="σ" aria-label="Despike sigma" /></template></span></div>
		<div class="stage"><label class="chk"><input v-model="workChain.detrend.on" class="tog" type="checkbox" /> Detrend</label>
			<span class="args"><template v-if="workChain.detrend.on"><select v-model="workChain.detrend.mode" aria-label="Detrend mode"><option value="highpass">high-pass</option><option value="dc">DC</option></select><input v-if="workChain.detrend.mode === 'highpass'" v-model.number="workChain.detrend.cutoff_hz" type="number" min="0.1" step="1" title="Cut-off (Hz)" aria-label="Detrend cut-off" /></template></span></div>
		<div class="stage"><label class="chk"><input v-model="workChain.highpass.on" class="tog" type="checkbox" /> High-pass</label>
			<span class="args"><template v-if="workChain.highpass.on"><input v-model.number="workChain.highpass.cutoff_hz" type="number" min="1" step="10" title="Cut-off (Hz)" aria-label="High-pass cut-off" /><input v-model.number="workChain.highpass.order" type="number" min="1" max="10" title="Order" aria-label="High-pass order" /></template></span></div>
		<div class="stage"><label class="chk"><input v-model="workChain.lowpass.on" class="tog" type="checkbox" /> Low-pass</label>
			<span class="args"><template v-if="workChain.lowpass.on"><input v-model.number="workChain.lowpass.cutoff_hz" type="number" min="1" step="100" title="Cut-off (Hz)" aria-label="Low-pass cut-off" /><input v-model.number="workChain.lowpass.order" type="number" min="1" max="10" title="Order" aria-label="Low-pass order" /></template></span></div>
		<div class="stage"><label class="chk"><input v-model="workChain.notch.on" class="tog" type="checkbox" /> Notch ×harmonics</label>
			<span class="args"><input v-if="workChain.notch.on" v-model.number="workChain.notch.q" type="number" min="1" step="5" title="Q" aria-label="Notch Q" /></span></div>
		<div v-if="workChain.notch.on" class="harm">
			<label v-for="h in [1, 2, 3, 4, 5]" :key="'h' + h" class="chk">
				<input class="tog" type="checkbox" :checked="workChain.notch.harmonics.includes(h)" @change="toggleHarmonic(h, ($event.target as HTMLInputElement).checked)" /> {{ h }}×
			</label>
		</div>

		<label class="chk preview"><input v-model="previewOn" class="tog" type="checkbox" /> Preview on the Lite map and FFT</label>
		<div v-if="previewOn && !liveOn" class="fp-note">Switch to <b>Lite</b> to preview the filtered map side by side. You can still edit and bake here.</div>
		<div v-if="filterBusy" class="fp-note"><v-progress-circular indeterminate x-small /> previewing…</div>
		<div v-if="filterErr" class="fp-err">{{ filterErr }}</div>
		<div v-if="filterSkipped.length" class="fp-note">Preview-only note: {{ filterSkipped.join('; ') }} — bake applies at full rate.</div>

		<div class="actions">
			<select class="prof" aria-label="Load a filter profile" @change="applyProfile(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
				<option value="">Load profile…</option>
				<option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
			</select>
			<button class="fp-link" @click="saveProfile">Save…</button>
		</div>
		<div class="actions">
			<button class="fp-btn" :disabled="baking || !chainActive(workChain)" title="Keep this filtered version as the op's default. Lite recomputes it live; Full & FRM PNG stay raw until you Bake." @click="applyFilter"><v-icon name="done" x-small /> Apply (Lite)</button>
			<button class="fp-btn primary" :disabled="baking || !chainActive(workChain) || !!bakeBlocked" :title="bakeBlocked || 'Reprocess the op on the host so ALL outputs (Lite, Full, FRM PNG) are filtered. Heavier; needs the orchestrator; admin-only.'" @click="bakeFilters"><v-icon :name="baking ? 'hourglass_top' : 'save'" x-small /> {{ baking ? 'Baking…' : 'Bake all' }}</button>
			<button v-if="savedChain" class="fp-btn" :disabled="baking" @click="clearFilter">Clear</button>
		</div>
		<div v-if="bakeBlocked" class="fp-note">{{ bakeBlocked }}</div>
	</template>
</template>

<style scoped>
.stage { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 31px; border-bottom: 1px solid var(--fp-line); font-size: var(--fs-md, 13px); }
.chk { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.tog { width: 16px; height: 16px; margin: 0; cursor: pointer; accent-color: var(--fp-accent); }
.args { display: flex; gap: 6px; }
.args input, .args select, .prof { font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; box-sizing: border-box; height: 26px; padding: 0 6px; border: 1px solid var(--theme--border-color); border-radius: 8px; background: var(--theme--form--field--input--background, var(--theme--background)); color: var(--theme--foreground); }
.args input { width: 64px; }
.args input:focus, .args select:focus, .prof:focus { outline: none; border-color: var(--fp-accent); }
.harm { display: flex; gap: 10px; padding: 4px 0 6px 22px; font-size: var(--fs-sm, 12px); }
.preview { margin: 10px 0 4px; font-size: var(--fs-md, 13px); }
.actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.prof { flex: 1 1 auto; min-width: 0; }
</style>
