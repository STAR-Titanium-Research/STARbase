<script setup lang="ts">
// Dedicated Kistler LabAmp page: connection, operation mode, the per-channel sensor table, and a
// settings reference explaining each parameter with recommended values. Talks to the backend
// /labamp/* (which proxies the link-local amp; mock by default so this works without hardware).
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { labamp, type AutoRangeRec, type SensorRow } from '../record/labampApi';
import { labampState, type LabAmpSnapshot } from './labampStore';
import { searchPastOperations } from '../record/directusLookups';
import LookupField from '../record/panels/LookupField.vue';

// Status, config and sensors come from the module-level snapshot (#109): the last-known values
// show at once on every visit and refresh in the background.
const status = computed(() => labampState.data.value?.status ?? null);
const sensors = computed<SensorRow[]>(() => labampState.data.value?.sensors ?? []);
const refreshing = labampState.loading;
const busy = ref(false);
const actionErr = ref<string | null>(null);
const err = computed({ get: () => actionErr.value ?? labampState.error.value, set: (v: string | null) => { actionErr.value = v; } });
const cfg = reactive({ base_url: '', channels: 8, mode: 'mock', autorange_headroom: 1.5 });
const savedCfg = ref(false);

// Auto-range (analog-output path: amp DAC -> NI-DAQ; effective bits = min(dac, nidaq))
const headroom = ref(1.5);
const daq = reactive({ nidaq_bits: 16, labamp_dac_bits: 12, analog_fullscale_v: 10 });
const effBits = ref(12);
const recs = ref<AutoRangeRec[] | null>(null);
const arStatus = ref<Record<string, string> | null>(null);
const arBusy = ref(false);
async function persistDaq() {
	await labamp.setConfig({ autorange_headroom: headroom.value, nidaq_bits: Number(daq.nidaq_bits), labamp_dac_bits: Number(daq.labamp_dac_bits), analog_fullscale_v: Number(daq.analog_fullscale_v) });
	// Saved: the server now holds these values, so later refreshes may seed the fields again --
	// but one already in flight read the server before this write and must not seed them back.
	labampState.invalidate();
	daqDirty.value = false;
}
const arSource = ref<'live' | 'previous'>('live');
// Searches both local recordings on this machine (exact per-channel peaks) and past operations
// already uploaded to the database (peaks approximated per channel — see directusLookups.ts).
//
// #39: multiple previous cuts can be selected at once, not just the last one picked — useful when
// no single recent cut alone reached the true worst-case peak on every channel (e.g. a roughing
// pass maxed Fz while a separate finishing pass maxed Fx). aggregatedPeaks (below) takes the
// element-wise MAX across every selected cut's peaks, the conservative choice for a range
// recommendation: it must safely cover the largest peak seen on each channel across whichever
// cuts are being considered, not their average.
const prevOpId = ref('');
interface PrevOp { id: string; label: string; peaksN: number[]; exact: boolean }
const prevOps = ref<PrevOp[]>([]);
// Remounts LookupField after each pick so its internal "chosen" state resets to a blank search box
// ready for the next selection, rather than needing to reach into its internals to clear it.
const pickerKey = ref(0);
function onPickPastOp(item: { id: string; label: string; extra?: { peaksN?: number[]; exact?: boolean } }) {
	if (!item.extra?.peaksN || prevOps.value.some((o) => o.id === item.id)) return;
	prevOps.value.push({ id: item.id, label: item.label, peaksN: item.extra.peaksN, exact: item.extra.exact ?? true });
	prevOpId.value = '';
	pickerKey.value++;
}
function removePrevOp(id: string) { prevOps.value = prevOps.value.filter((o) => o.id !== id); }
const aggregatedPeaks = computed<number[] | null>(() => {
	if (!prevOps.value.length) return null;
	const n = Math.max(...prevOps.value.map((o) => o.peaksN.length));
	return Array.from({ length: n }, (_, i) => Math.max(...prevOps.value.map((o) => o.peaksN[i] ?? 0)));
});
const aggregatedExact = computed(() => prevOps.value.length > 0 && prevOps.value.every((o) => o.exact));
async function measure() {
	arBusy.value = true; err.value = null; arStatus.value = null;
	try {
		await persistDaq();
		if (arSource.value === 'previous') {
			if (!aggregatedPeaks.value) { err.value = 'pick at least one previous recording'; arBusy.value = false; return; }
			const currents = sensors.value.map(s => s.range ?? 10000);
			const r = await labamp.converge({ peaks: aggregatedPeaks.value, currents, headroom: headroom.value, apply: false });
			recs.value = r.recommendations; effBits.value = r.effective_bits;
		} else {
			const r = await labamp.autorange(headroom.value);
			recs.value = r.recommendations; effBits.value = r.effective_bits;
		}
	} catch (e: any) { err.value = e?.message || 'measure failed'; } finally { arBusy.value = false; }
}
async function applyRanges() {
	arBusy.value = true; err.value = null;
	try { await persistDaq(); const r = await labamp.autorangeApply(headroom.value); recs.value = r.applied; arStatus.value = r.status; await refresh(true); }
	catch (e: any) { err.value = e?.message || 'apply failed'; } finally { arBusy.value = false; }
}
function fmtRes(x: number) { return x >= 1 ? x.toFixed(2) : x >= 0.001 ? x.toFixed(4) : x.toExponential(1); }

// Calibration editing
const editing = ref<number | null>(null);
const editSens = ref(0);
const editRange = ref(0);
const writeBusy = ref(false);
function startEdit(s: SensorRow) {
	editing.value = s.channel;
	editSens.value = s.sensitivity ?? 0;
	editRange.value = s.range ?? 0;
}
function cancelEdit() { editing.value = null; }
async function writeCalibration() {
	if (editing.value == null) return;
	writeBusy.value = true; err.value = null;
	try {
		const res = await labamp.writeSensors([{ channel: editing.value, sensitivity: editSens.value, range: editRange.value }]);
		labampState.mutate((cur) => ({ ...cur!, sensors: res.sensors }));
		editing.value = null;
	} catch (e: any) { err.value = e?.message || 'write failed'; }
	finally { writeBusy.value = false; }
}

// A background refresh must not overwrite what the user is typing: the connection form and the
// DAQ/headroom fields are only re-seeded from the snapshot while they hold no unsaved edit. The
// watchers are sync so the seeding below can tell its own writes from the user's.
const cfgDirty = ref(false);
const daqDirty = ref(false);
let seeding = false;
watch(cfg, () => { if (!seeding) cfgDirty.value = true; }, { deep: true, flush: 'sync' });
watch([headroom, daq], () => { if (!seeding) daqDirty.value = true; }, { deep: true, flush: 'sync' });
function seedForms(snap: LabAmpSnapshot) {
	seeding = true;
	try {
		if (!cfgDirty.value) Object.assign(cfg, { base_url: snap.status.base_url, channels: snap.status.channels, mode: snap.status.config_mode });
		if (!daqDirty.value) {
			const conf = snap.config;
			if (conf.autorange_headroom) headroom.value = conf.autorange_headroom;
			if (conf.nidaq_bits) daq.nidaq_bits = conf.nidaq_bits;
			if (conf.labamp_dac_bits) daq.labamp_dac_bits = conf.labamp_dac_bits;
			if (conf.analog_fullscale_v) daq.analog_fullscale_v = conf.analog_fullscale_v;
			effBits.value = Math.min(daq.labamp_dac_bits, daq.nidaq_bits);
		}
	} finally { seeding = false; }
}
watch(() => labampState.data.value, (snap) => { if (snap) seedForms(snap); }, { immediate: true });

// `afterWrite`: the caller has just changed server state, so don't join a request that started
// before the change (it may carry the old values).
async function refresh(afterWrite = false) {
	actionErr.value = null;
	await labampState.revalidate({ fresh: afterWrite });
}
async function saveCfg() {
	busy.value = true; err.value = null;
	try { await labamp.setConfig({ base_url: cfg.base_url, channels: Number(cfg.channels), mode: cfg.mode }); labampState.invalidate(); cfgDirty.value = false; savedCfg.value = true; setTimeout(() => (savedCfg.value = false), 1600); await refresh(true); }
	catch (e: any) { err.value = e?.message || 'save failed'; } finally { busy.value = false; }
}
async function setMode(mode: 'MEASURE' | 'RESET') {
	busy.value = true; err.value = null;
	try { const r = await labamp.setMode(mode); if (labampState.data.value) labampState.mutate((cur) => ({ ...cur!, status: { ...cur!.status, mode: r.mode } })); }
	catch (e: any) { err.value = e?.message || 'set mode failed'; } finally { busy.value = false; }
}

const reference = [
	{ name: 'Operation mode', what: 'MEASURE integrates charge into force; RESET zeroes drift.', rec: 'RESET between cuts, MEASURE during. The app handles this automatically on start/stop.' },
	{ name: 'Sensitivity (pC/N)', what: 'Charge sensitivity per channel from the dynamometer calibration certificate.', rec: 'Click Edit on the channel row above to enter the exact certificate value (Fx/Fy ≈ −7.9, Fz ≈ −3.7 pC/N typical).' },
	{ name: 'Measuring range', what: 'Full-scale N mapped to ±10 V analog output. The 12-bit DAC bottleneck means range selection directly affects resolution.', rec: 'Use Auto-range below, or pick the smallest range that clears peak force with ~1.5× headroom.' },
];
onMounted(() => { void labampState.revalidate(); });
</script>

<template>
	<div class="labamp-page">
		<header class="head">
			<h1>Lab Amplifier</h1>
			<div class="conn" :class="{ ok: status?.reachable }">
				<span class="material-symbols-rounded">{{ status?.reachable ? 'link' : 'link_off' }}</span>
				{{ status?.reachable ? 'Connected' : 'Not connected' }}
				<span v-if="status?.mock" class="mock">mock</span>
			</div>
			<button class="btn icon ic" :class="{ spinning: refreshing }" :disabled="busy || refreshing" title="Refresh" aria-label="Refresh" @click="refresh()"><span class="material-symbols-rounded">refresh</span></button>
		</header>

		<div class="grid">
			<section class="card">
				<h2>Connection</h2>
				<label data-focus="labamp-url">Amplifier URL<input v-model="cfg.base_url" placeholder="http://169.254.143.59" spellcheck="false" @input="cfg.mode = 'real'" /></label>
				<div class="two">
					<label>Channels<input type="number" v-model.number="cfg.channels" /></label>
					<label>Source
						<select v-model="cfg.mode"><option value="mock">mock (no hardware)</option><option value="real">real amplifier</option></select>
					</label>
				</div>
				<p class="hint">The amp is link-local (e.g. <code>169.254.143.59</code>) and reachable only from the acquisition PC; the backend proxies it.
					Entering a URL switches Source to <b>real amplifier</b> automatically — pick <b>mock</b> explicitly to simulate without hardware.</p>
				<button class="btn primary" :disabled="busy" @click="saveCfg">{{ savedCfg ? 'Saved ✓' : 'Save connection' }}</button>
				<p v-if="err" class="err">{{ err }}</p>
			</section>

			<section class="card">
				<h2>Operation mode</h2>
				<div class="segmode lg mode-seg">
					<button class="segbtn" :class="{ on: status?.mode === 'MEASURE' }" :disabled="busy || !status?.reachable" @click="setMode('MEASURE')">MEASURE</button>
					<button class="segbtn" :class="{ on: status?.mode === 'RESET' }" :disabled="busy || !status?.reachable" @click="setMode('RESET')">RESET</button>
				</div>
				<p class="hint">MEASURE integrates charge into force; RESET zeroes drift between cuts.</p>
				<a class="export" :href="labamp.exportUrl()" target="_blank" rel="noopener"><span class="material-symbols-rounded">download</span> Export full config</a>
			</section>

			<section class="card wide">
				<h2>Channels <span class="cal-hint">click a row to edit calibration values</span></h2>
				<table v-if="sensors.length">
					<thead><tr><th>Ch</th><th>Name</th><th>Serial</th><th>Quantity</th><th>Sensitivity (pC/N)</th><th>Range (N)</th><th></th></tr></thead>
					<tbody>
						<tr v-for="s in sensors" :key="s.channel" :class="{ 'edit-row': editing === s.channel }">
							<td>{{ s.channel }}</td><td>{{ s.name }}</td><td>{{ s.serialNumber }}</td>
							<td>{{ s.physicalQuantity }}</td>
							<template v-if="editing === s.channel">
								<td><input type="number" step="0.01" v-model.number="editSens" class="cal-input" /></td>
								<td><input type="number" step="1" v-model.number="editRange" class="cal-input" /></td>
								<td class="cal-actions">
									<button class="btn sm primary" :disabled="writeBusy" @click="writeCalibration">Write</button>
									<button class="btn sm" @click="cancelEdit">Cancel</button>
								</td>
							</template>
							<template v-else>
								<td>{{ s.sensitivity }}</td><td>{{ s.range }}</td>
								<td><button class="btn icon sm" title="Edit calibration" aria-label="Edit calibration" @click="startEdit(s)" :disabled="!status?.reachable"><span class="material-symbols-rounded">edit</span></button></td>
							</template>
						</tr>
					</tbody>
				</table>
				<p v-else-if="refreshing && !labampState.data.value" class="hint">Loading channels…</p>
				<p v-else class="hint">No channel data — connect the amplifier (or use mock) and refresh.</p>
			</section>

			<section class="card wide">
				<h2>Auto-range</h2>
				<p class="hint">The amp's <b>analog-output DAC</b> is limited to <b>{{ daq.labamp_dac_bits }}-bit</b> (no recording
					licence) and feeds the {{ daq.nidaq_bits }}-bit NI-DAQ, so the <b>true bit depth is the bottleneck</b> —
					<b>{{ effBits }}-bit</b> (min of the two). The range sets the V→N mapping (<code>N/V = range / {{ daq.analog_fullscale_v }} V</code>)
					and the resolution is ≈ range / 2<sup>{{ effBits - 1 }}</sup>. With only {{ effBits }} bits it's important to pick
					the smallest range that clears the peak with headroom (a smaller range swings more of the ±{{ daq.analog_fullscale_v }} V,
					using more of the scarce codes). Too small clips (<code>OR_INPUT</code>). When auto-range is applied, each channel's
					range → its own V→N gain, used per-channel in the recording.
					<b>Workflow:</b> RESET → MEASURE, run a representative test cut, then Measure &amp; recommend.</p>
				<div class="ar-source">
					<span class="ar-label">Peak source:</span>
					<div class="segmode">
						<button class="segbtn" :class="{ on: arSource === 'live' }" @click="arSource = 'live'">Live measurement</button>
						<button class="segbtn" :class="{ on: arSource === 'previous' }" @click="arSource = 'previous'">Previous run</button>
					</div>
				</div>
				<div v-if="arSource === 'previous'" class="prev-peaks">
					<!-- #39: pick several previous cuts, not just one -- each pick adds a chip below
						 rather than replacing the last one. :key remounts the field after each pick so
						 its "chosen" state resets to a blank search box for the next selection. -->
					<LookupField :key="pickerKey" v-model="prevOpId" label="Previous recording(s)" placeholder="search sample code or pass code…"
						:search="searchPastOperations" :selected-ids="prevOps.map((o) => o.id)" hide-selected @select="onPickPastOp" />
					<div v-if="prevOps.length" class="prev-op-chips">
						<span v-for="o in prevOps" :key="o.id" class="chip" :class="o.exact ? 'exact' : 'approx'"
							:title="o.exact ? 'Exact per-channel peaks from this recorder\'s own capture history.' : 'The database only stores summed-axis peaks (Fx/Fy/Fz), not per-channel — these are estimated by splitting each axis peak evenly across its sub-channels.'">
							{{ o.label }}
							<button type="button" @click="removePrevOp(o.id)" title="Remove"><span class="material-symbols-rounded">close</span></button>
						</span>
						<span class="tag" :class="aggregatedExact ? 'exact' : 'approx'"
							title="The recommendation below uses, per channel, the largest peak seen across ALL selected cuts.">
							{{ prevOps.length }} selected · {{ aggregatedExact ? 'exact' : 'includes approximate' }}
						</span>
					</div>
					<p class="hint">Searches local recordings on this machine (exact per-channel peaks) and past operations in the database (peaks approximated per channel) — pick as many as are relevant; the recommendation uses each channel's largest peak across all of them.</p>
				</div>
				<div class="ar-controls">
					<label>Headroom ×<input type="number" step="0.1" min="1" v-model.number="headroom" /></label>
					<label>Amp DAC bits<input type="number" step="1" v-model.number="daq.labamp_dac_bits" /></label>
					<label>NI-DAQ bits<input type="number" step="1" v-model.number="daq.nidaq_bits" /></label>
					<label>Analog full-scale (±V)<input type="number" step="0.5" v-model.number="daq.analog_fullscale_v" /></label>
					<button class="btn" :disabled="arBusy || (arSource === 'live' && !status?.reachable) || (arSource === 'previous' && !prevOps.length)" @click="measure">{{ arSource === 'previous' ? 'Recommend from peaks' : 'Measure & recommend' }}</button>
					<button class="btn primary" :disabled="arBusy || !recs" @click="applyRanges">Apply recommended ranges</button>
				</div>
				<table v-if="recs">
					<thead><tr><th>Ch</th><th>Peak (N)</th><th>Current</th><th>Recommended</th><th>Gain (N/V)</th><th>Res. (N/LSB)</th><th>Bits used</th><th>Output</th><th></th></tr></thead>
					<tbody>
						<tr v-for="r in recs" :key="r.channel" :class="{ clip: r.would_clip }">
							<td>{{ r.channel }}</td><td>{{ r.peak.toFixed(1) }}</td><td>{{ r.current ?? '—' }}</td>
							<td><b>{{ r.recommended }}</b></td><td>{{ r.gain_n_per_v }}</td><td>{{ fmtRes(r.resolution) }}</td>
							<td>{{ r.bits_used }} / {{ effBits }}</td><td>{{ r.output_pct }}%</td>
							<td>
								<span v-if="r.would_clip" class="tag clip">clips now</span>
								<span v-else-if="arStatus && arStatus[r.channel] && arStatus[r.channel] !== 'OK'" class="tag or">{{ arStatus[r.channel] }}</span>
								<span v-else-if="arStatus" class="tag ok">OK</span>
							</td>
						</tr>
					</tbody>
				</table>
			</section>

			<section class="card wide">
				<h2>Settings reference</h2>
				<div v-for="r in reference" :key="r.name" class="ref">
					<div class="ref-name">{{ r.name }}</div>
					<div class="ref-what">{{ r.what }}</div>
					<div class="ref-rec"><span class="material-symbols-rounded">check_circle</span>{{ r.rec }}</div>
				</div>
			</section>
		</div>
	</div>
</template>

<style scoped>
.labamp-page { min-height: 100vh; background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg)); }
.head { display: flex; align-items: center; gap: 14px; padding: 20px 26px 14px; border-bottom: 1px solid var(--border); }
.head h1 { margin: 0; font-size: var(--fs-2xl); }
.conn { display: flex; align-items: center; gap: 6px; font-size: var(--fs-md); font-weight: 600; color: var(--text-dim); }
.conn.ok { color: var(--ok); }
.conn .material-symbols-rounded { font-size: var(--icon-md); }
.mock { font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); padding: 1px 6px; border-radius: 10px; }
.ic { margin-left: auto; }
/* A background refresh (#109) is visible on the button only; the page keeps showing the last
   snapshot meanwhile. */
.ic.spinning .material-symbols-rounded { animation: la-spin 0.9s linear infinite; }
@keyframes la-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ic.spinning .material-symbols-rounded { animation: none; opacity: 0.5; } }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding: 22px 26px; max-width: 1100px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
.card.wide { grid-column: 1 / -1; }
h2 { margin: 0 0 12px; font-size: var(--fs-lg); }
label { display: block; font-size: var(--fs-sm); color: var(--text-dim); margin-bottom: 12px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
input, select { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font-size: var(--fs-md); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; }
.hint { font-size: var(--fs-sm); color: var(--text-dim); line-height: 1.5; margin: 4px 0 12px; }
.hint code { font-family: var(--mono); color: var(--text); }
/* The operation-mode switch spans its card. */
.mode-seg { display: flex; }
.mode-seg .segbtn { flex: 1; }
.export { display: inline-flex; align-items: center; gap: 5px; margin-top: 12px; font-size: var(--fs-md); color: var(--accent); text-decoration: none; }
.export .material-symbols-rounded { font-size: var(--icon-sm); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 8px 0 0; }
.card.wide { overflow-x: auto; }
table { width: 100%; min-width: 480px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: var(--fs-md); }
th { color: var(--text-dim); font-weight: 600; }

@media (max-width: 640px) {
	.grid, .two { grid-template-columns: 1fr; }
	.head { flex-wrap: wrap; gap: 8px; padding: 16px; }
	.ic { margin-left: 0; }
	.grid { padding: 16px; }
}
.ar-source { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ar-label { font-size: var(--fs-sm); color: var(--text-dim); }
.prev-peaks { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.prev-peaks .tag { margin-bottom: 8px; }
.prev-peaks :deep(.lookup) { flex: 1; min-width: 260px; margin-bottom: 0; }
.prev-peaks .hint { flex-basis: 100%; margin: 0; }
.prev-op-chips { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.prev-op-chips .chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); font-weight: 600; padding: 2px 4px 2px 8px; border-radius: 10px; cursor: help; }
.prev-op-chips .chip.exact { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.prev-op-chips .chip.approx { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.prev-op-chips .chip button { display: inline-flex; padding: 2px; color: inherit; background: transparent; border: none; border-radius: 50%; cursor: pointer; opacity: 0.7; }
.prev-op-chips .chip button:hover { opacity: 1; background: rgba(0,0,0,0.15); }
.prev-op-chips .chip .material-symbols-rounded { font-size: var(--icon-xs); }
.ar-controls { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.ar-controls label { margin: 0; }
.ar-controls input { width: 90px; }
tr.clip td { background: rgba(239,68,68,0.08); }
.tag { font-size: var(--fs-xs); font-weight: 700; padding: 1px 7px; border-radius: 10px; }
.tag.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.tag.clip, .tag.or { color: #fca5a5; background: rgba(252,165,165,0.12); }
.tag.exact { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); cursor: help; }
.tag.approx { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); cursor: help; }
.ref { padding: 10px 0; border-bottom: 1px solid var(--border); }
.ref:last-child { border-bottom: 0; }
.ref-name { font-size: var(--fs-md); font-weight: 640; color: var(--text); }
.ref-what { font-size: var(--fs-md); color: var(--text-dim); margin: 3px 0; line-height: 1.5; }
.ref-rec { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-md); color: #86efac; line-height: 1.5; }
.ref-rec .material-symbols-rounded { font-size: var(--icon-sm); margin-top: 1px; }
.cal-hint { font-size: var(--fs-xs); font-weight: 400; color: var(--text-dim); margin-left: 8px; }
.cal-input { width: 100px !important; padding: 4px 6px !important; font-size: var(--fs-sm) !important; margin: 0 !important; text-align: right; }
.cal-actions { display: flex; gap: 4px; }
.edit-row td { background: color-mix(in srgb, var(--accent) 6%, transparent); }
</style>
