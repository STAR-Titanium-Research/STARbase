<script setup lang="ts">
// Fallback plot view for a recording that hasn't (yet) been uploaded/linked into the database —
// e.g. the upload failed, was skipped, or the machine is offline. Reads the finished capture
// directly from the recorder backend's local files (summary.json + live_cache.bin), so the user
// can always consult and plot a cut regardless of its database status. Reading never depends on
// Directus; retrying the upload rebuilds a run record from summary.json alone (see
// uploadCapture.ts) since navigating here from the Record page unmounts its live session/workspace
// entirely - there is nothing left to "still be connected" to.
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getConfig } from '../config';
import { FrmCloud, parseCache, useAutoColorScale, type Cache } from '@d1/force-plotting';
import FinishedForcePlot from '../record/FinishedForcePlot.vue';
import { uploadCaptureColdStart } from '../record/uploadCapture';
import { cropWindowSec } from '../record/cropOverride';

const route = useRoute();
const router = useRouter();
const captureId = computed(() => String(route.params.captureId || ''));
const baseUrl = getConfig().recorderUrl;

const loading = ref(true);
const errMsg = ref<string | null>(null);
const summary = ref<any | null>(null);
const cache = ref<Cache | null>(null);
const axis = ref<'Fx' | 'Fy' | 'Fz'>('Fz');

// This view has no colour-scale editor, so the scale just follows the cloud's own auto range.
const { colorScale, onClimits } = useAutoColorScale();

// The crop the operator set in the final summary (kept in summary.json), else the cache's own.
const crop = computed(() => cache.value ? cropWindowSec(summary.value, cache.value) : null);

const retrying = ref(false);
const retryErr = ref<string | null>(null);
const retryOpId = ref<string | null>(null);

async function load() {
	loading.value = true;
	errMsg.value = null;
	try {
		const [sumRes, cacheRes] = await Promise.all([
			fetch(`${baseUrl}/captures/${captureId.value}/summary`),
			fetch(`${baseUrl}/captures/${captureId.value}/live_cache.bin`),
		]);
		if (!sumRes.ok) throw new Error(`summary: HTTP ${sumRes.status}`);
		if (!cacheRes.ok) throw new Error(`live_cache.bin: HTTP ${cacheRes.status}`);
		summary.value = await sumRes.json();
		cache.value = parseCache(await cacheRes.arrayBuffer());
	} catch (e: any) {
		errMsg.value = e?.message || 'failed to load this capture';
	} finally {
		loading.value = false;
	}
}
onMounted(load);

async function retryUpload() {
	if (!summary.value) return;
	retrying.value = true;
	retryErr.value = null;
	try {
		retryOpId.value = await uploadCaptureColdStart({
			captureId: captureId.value,
			matUrl: `${baseUrl}/captures/${captureId.value}/capture.mat`,
			cacheUrl: `${baseUrl}/captures/${captureId.value}/live_cache.bin`,
			cfg: summary.value.config || {},
			peaks: summary.value.peaks,
			cache: cache.value,
			matWritten: summary.value.mat_written,
			summary: summary.value,
		});
	} catch (e: any) {
		retryErr.value = e?.message || 'retry failed';
	} finally {
		retrying.value = false;
	}
}

function goToDbPlot() {
	if (retryOpId.value) router.push({ name: 'plot', query: { operation: retryOpId.value } });
}
</script>

<template>
	<div class="lcv">
		<header class="lcv-head">
			<button class="lcv-back" title="Back" @click="router.push({ name: 'record' })">
				<span class="material-symbols-rounded">arrow_back</span>
			</button>
			<div class="lcv-title">
				<b>{{ summary?.sample_name || captureId }}</b>
				<span class="lcv-sub">local capture · not linked in the database</span>
			</div>
		</header>

		<div v-if="loading" class="lcv-loading">
			<span class="material-symbols-rounded spin">progress_activity</span>
			<span>Loading capture…</span>
		</div>

		<div v-else-if="errMsg" class="lcv-err">
			<span class="material-symbols-rounded">error</span>
			<div>
				<p>Couldn't load this capture: {{ errMsg }}</p>
				<button class="btn sm lcv-btn" @click="load">Retry</button>
			</div>
		</div>

		<template v-else>
			<div class="lcv-banner">
				<span class="material-symbols-rounded">cloud_off</span>
				<span>This recording is saved locally but hasn't been uploaded to the database{{ retryOpId ? ' — it has now been logged.' : '.' }}</span>
				<div class="lcv-spacer"></div>
				<template v-if="retryOpId">
					<button class="btn sm primary lcv-btn" @click="goToDbPlot">Open database record</button>
				</template>
				<template v-else>
					<button class="btn sm primary lcv-btn" :disabled="retrying" @click="retryUpload">{{ retrying ? 'Uploading…' : 'Retry upload' }}</button>
				</template>
			</div>
			<p v-if="retryErr" class="lcv-retryerr">{{ retryErr }}</p>

			<div class="lcv-stats">
				<div class="lcv-stat"><span>Duration</span><b>{{ (summary?.duration_sec ?? 0).toFixed(1) }}s</b></div>
				<div class="lcv-stat"><span>Samples</span><b>{{ (summary?.n ?? 0).toLocaleString() }}</b></div>
				<div class="lcv-stat"><span>Rate</span><b>{{ summary?.fs ?? '—' }} Hz</b></div>
				<div class="lcv-stat"><span>Fx peak</span><b>{{ (summary?.peaks?.Fx ?? 0).toFixed(1) }}</b></div>
				<div class="lcv-stat"><span>Fy peak</span><b>{{ (summary?.peaks?.Fy ?? 0).toFixed(1) }}</b></div>
				<div class="lcv-stat"><span>Fz peak</span><b>{{ (summary?.peaks?.Fz ?? 0).toFixed(1) }}</b></div>
			</div>

			<div class="lcv-plots">
				<div class="lcv-plot">
					<div class="lcv-plot-label">Force</div>
					<FinishedForcePlot v-if="cache" :cache="cache" :crop-start-sec="crop?.startSec" :crop-end-sec="crop?.endSec" />
				</div>
				<div class="lcv-plot">
					<div class="lcv-plot-label">
						FRM
						<span class="lcv-axisbtns segmode">
							<button v-for="a in (['Fx','Fy','Fz'] as const)" :key="a" class="segbtn" :class="[a.toLowerCase(), { on: axis === a }]" @click="axis = a">{{ a }}</button>
						</span>
					</div>
					<FrmCloud v-if="cache && summary" cache-file-id="" :cache-override="cache"
						:axis="axis" :feed="cache.feed" :diam="cache.diam" :inner-diam="summary.config?.inner_diam ?? 0"
						speed-mode="measured" :rpm="summary.config?.rpm ?? 0" :vc="0" :time-scale="1" :ppr="summary.config?.ppr ?? 1"
						:crop-start-sec="crop!.startSec" :crop-end-sec="crop!.endSec"
						:stride="1" :gridding="false" :grid-n="600" :point-size="2" :color-scale="colorScale"
						pane-label="local" @climits="onClimits" />
				</div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.lcv { min-height: 100vh; padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg)); }
.lcv-head { display: flex; align-items: center; gap: 12px; }
.lcv-back { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; background: var(--surface); border: 1px solid var(--border); color: var(--text); cursor: pointer; }
.lcv-title { display: flex; flex-direction: column; }
.lcv-title b { font-size: var(--fs-lg); }
.lcv-sub { font-size: var(--fs-sm); color: var(--text-dim); }
.lcv-loading, .lcv-err { display: flex; align-items: center; gap: 10px; justify-content: center; padding: 60px 0; color: var(--text-dim); }
.lcv-loading .spin { font-size: var(--icon-xl); }
.lcv-err { color: var(--danger); }
.lcv-btn { margin-top: 6px; }
.lcv-banner { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: color-mix(in srgb, var(--warn) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: 10px; font-size: var(--fs-md); color: var(--text); }
.lcv-banner > .material-symbols-rounded { color: var(--warn); font-size: var(--icon-lg); }
.lcv-spacer { flex: 1; }
.lcv-retryerr { font-size: var(--fs-sm); color: var(--danger); margin: -8px 0 0; }
.lcv-stats { display: flex; gap: 8px; flex-wrap: wrap; }
.lcv-stat { display: flex; flex-direction: column; align-items: center; padding: 6px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; min-width: 76px; }
.lcv-stat span { font-size: var(--fs-xs); color: var(--text-dim); letter-spacing: 0.01em; }
.lcv-stat b { font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.lcv-plots { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; flex: 1; min-height: 420px; }
.lcv-plot { display: flex; flex-direction: column; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-height: 380px; }
.lcv-plot-label { font-size: var(--fs-sm); font-weight: 600; color: var(--text-dim); display: flex; align-items: center; gap: 8px; }
.lcv-axisbtns { margin-left: auto; }
</style>
