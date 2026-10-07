<script setup lang="ts">
// The window/channel controls here mirror ForcePanel.vue's toolbar deliberately, and the mode is
// picked from the title as in the panel's header — this route used to only read mode/channels/
// window from the opening URL once and never expose any way to change them afterward, so a
// pop-out was frozen at whatever was selected the moment it opened.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { RecordClient, SUB_NAMES } from './liveClient';
import { channelColor } from './types';
import { theme } from '../theme';
import LiveForcePlot from './LiveForcePlot.vue';
import LiveFft from './LiveFft.vue';
import LiveSpectrogram from './LiveSpectrogram.vue';
import LiveWaterfall from './LiveWaterfall.vue';
import LiveFrm from './LiveFrm.vue';
import { COLORMAPS, colormapLabel, PlotModeFlyout, useAutoColorScale, type ColorScale } from '@d1/force-plotting';
import { PLOT_MODES } from './plotModes';
import { clampWindowSec, WINDOW_MAX_SEC, WINDOW_MIN_SEC, WINDOW_SLIDER_MAX_SEC } from './plotWindow';

const route = useRoute();
const panel = computed(() => String(route.params.panel || 'force'));
const isFrm = computed(() => panel.value === 'frm');
const isPolar = computed(() => panel.value === 'polar');

const q = new URLSearchParams(window.location.search);
const mode = ref<string>(q.get('mode') || 'time');
const SUMMED = ['Fx', 'Fy', 'Fz'];
const ORDER = [...SUMMED, ...SUB_NAMES];
const channels = ref<string[]>(q.get('channels')?.split(',').filter(Boolean) || [...SUMMED]);
const windowSec = ref(clampWindowSec(Number(q.get('window'))));
const initColormap = ref<string>(q.get('colormap') || 'viridis');
const initPointSize = ref(Number(q.get('pointSize')) || 2.2);
const frmAxis = ref<'Fx' | 'Fy' | 'Fz'>((q.get('frmAxis') as 'Fx' | 'Fy' | 'Fz') || 'Fz');
const initStride = ref(Number(q.get('stride')) || 1);
// Polar pop-out: mirrors PolarPanel.vue's radius/angle-source selection so the two surfaces stay
// in sync when opened from the panel (query params carry the panel's current selection).
const polarRadius = ref<'Fz' | 'Fxy' | 'Mz'>((q.get('radius') as 'Fz' | 'Fxy' | 'Mz') || 'Fz');
const polarAngleSource = ref<'tacho' | 'force_vector'>((q.get('angle') as 'tacho' | 'force_vector') || 'tacho');

// The OS window title (taskbar/alt-tab); the bar itself shows the mode picker instead.
const title = computed(() => {
	if (isFrm.value) return 'Live FRM Fingerprint';
	if (isPolar.value) return 'Live Polar Plot';
	return `Live ${PLOT_MODES.find((m) => m.key === mode.value)?.label ?? 'Time'} Plot`;
});

const singleChannelMode = computed(() => mode.value === 'spectrogram' || mode.value === 'waterfall');
function toggleChannel(key: string) {
	if (singleChannelMode.value) { channels.value = [key]; return; }
	const s = channels.value.slice();
	const i = s.indexOf(key);
	if (i >= 0) { if (s.length > 1) s.splice(i, 1); } else s.push(key);
	channels.value = ORDER.filter((k) => s.includes(k));
}
// Matches ForcePanel.vue's guard (#32/#58): collapses a stale multi-selection when switching into,
// or opening the pop-out already in, spectrogram/waterfall mode -- a heatmap has nowhere to put a
// second channel, so what's ticked must always match what's shown.
watch(singleChannelMode, (single) => {
	if (single && channels.value.length > 1) channels.value = [channels.value[0]];
}, { immediate: true });
const subsOpen = ref(false);
const subCount = computed(() => channels.value.filter((k) => (SUB_NAMES as readonly string[]).includes(k)).length);

const client = new RecordClient();
// This window's OWN view (#105): every plot below slices it out of the trace history, so it is not
// overwritten by the opener's snapshots, which only replace the data. Clamped: the number input
// can be cleared to empty/NaN, and a non-positive window would draw nothing.
const viewWindowSec = computed(() => clampWindowSec(windowSec.value));
watch(viewWindowSec, (v) => client.setWindowDemand('view', v), { immediate: true });
const st = client.status;
const ready = computed(() => client.snapshotReady.value);
const colormap = ref(initColormap.value);
const pointSize = ref(initPointSize.value);
const maps = Object.keys(COLORMAPS);

// This pop-out's own FRM colour scale -- FULLY INDEPENDENT of whatever the main window's is doing
// (explicit design decision: a popped-out window can show the same live cut in a different colour
// scale for side-by-side comparison, not a mirrored read-only view). Its own local autoClimits, fed
// only by this LiveFrm instance's own climits event, never anything from the opener window; the
// only thing carried across at all is the initial colormap choice via the querystring, matching
// every other seed on this page (mode/channels/window/etc.).
const { colorScale: autoFrmScale, onClimits: onFrmClimits } = useAutoColorScale();
const frmColorScale = computed<ColorScale>(() => ({ ...autoFrmScale.value, colormap: colormap.value }));

// Keeps the OS window title (taskbar/alt-tab) in sync with a mode change made after opening —
// onMounted alone only ever set it once, from the URL the window was opened with.
watch(title, (t) => { document.title = t; }, { immediate: true });

onMounted(() => { client.connectViaRelay(); });
onBeforeUnmount(() => client.disconnect());
</script>

<template>
	<div class="live-window">
		<header class="bar">
			<span class="rec-dot" :class="{ live: st.state === 'recording' }"></span>
			<!-- Same picker as the panel header: the title is the mode. flex:1 gives it room to slide
				 open, which pushes the channel controls to the right-hand end of the bar. -->
			<div v-if="!isFrm && !isPolar" class="title-slot">
				<PlotModeFlyout v-model="mode" class="title" :modes="PLOT_MODES" />
				<span class="state" :class="st.state">{{ st.state }}</span>
			</div>
			<template v-else>
				<span class="title">{{ title }}</span>
				<span class="state" :class="st.state">{{ st.state }}</span>
			</template>
			<template v-if="isFrm">
				<div class="segmode">
					<button class="segbtn fx" :class="{ on: frmAxis === 'Fx' }" @click="frmAxis = 'Fx'">Fx</button>
					<button class="segbtn fy" :class="{ on: frmAxis === 'Fy' }" @click="frmAxis = 'Fy'">Fy</button>
					<button class="segbtn fz" :class="{ on: frmAxis === 'Fz' }" @click="frmAxis = 'Fz'">Fz</button>
				</div>
				<select v-model="colormap" class="cm"><option v-for="m in maps" :key="m" :value="m">{{ colormapLabel(m) }}</option></select>
			</template>
			<template v-else-if="isPolar">
				<div class="segmode">
					<button v-for="r in (['Fz', 'Fxy', 'Mz'] as const)" :key="r" class="segbtn" :class="{ on: polarRadius === r }" @click="polarRadius = r">{{ r }}</button>
				</div>
				<select v-model="polarAngleSource" class="cm">
					<option value="tacho">Tacho</option>
					<option value="force_vector">atan2(Fy,Fx)</option>
				</select>
			</template>
			<template v-else>
				<div class="chips">
					<button v-for="a in SUMMED" :key="a" class="chip-toggle" :style="channels.includes(a) ? { '--c': channelColor(a, theme) } : {}"
						:class="{ on: channels.includes(a) }" @click="toggleChannel(a)">{{ a }}</button>
				</div>
				<div class="subwrap">
					<button class="chip-toggle sub-btn" :class="{ on: subCount > 0 }" @click.stop="subsOpen = !subsOpen">
						Sub<span v-if="subCount"> · {{ subCount }}</span> <span class="material-symbols-rounded">expand_more</span>
					</button>
					<div v-if="subsOpen" class="subpop" @click.stop>
						<button v-for="s in SUB_NAMES" :key="s" class="subopt" :class="{ on: channels.includes(s) }" @click="toggleChannel(s)">
							<span class="dot" :style="{ background: channelColor(s, theme) }"></span>{{ s }}
							<span v-if="channels.includes(s)" class="material-symbols-rounded tick">check</span>
						</button>
					</div>
				</div>
				<span v-if="singleChannelMode" class="mono-hint" title="Spectrogram/waterfall show one channel">{{ channels[0] }} only</span>
				<div v-if="mode !== 'fft' && mode !== 'psd'" class="tw-row">
					<input type="range" min="2" :max="WINDOW_SLIDER_MAX_SEC" step="1" v-model.number="windowSec" />
					<input type="number" :min="WINDOW_MIN_SEC" :max="WINDOW_MAX_SEC" v-model.number="windowSec" class="tw-num" />
					<span class="tw-unit">s</span>
				</div>
			</template>
			<span class="conn" :class="{ ok: st.connected }">
				<span class="material-symbols-rounded">{{ st.connected ? 'sensors' : 'sensors_off' }}</span>
			</span>
			<div class="readouts">
				<template v-if="st.cutStartSec !== null"><b class="cut">&#x2713; cut</b><span>{{ st.cutStartSec.toFixed(2) }}s</span></template>
				<b>{{ Math.round(st.rpm) }}</b><span>rpm</span>
				<b class="fz">{{ st.peaks.Fz.toFixed(0) }}</b><span>Fz peak</span>
			</div>
		</header>
		<div class="body" @click="subsOpen = false">
			<div v-if="!ready" class="syncing">
				<span class="material-symbols-rounded spin">sync</span>
				<span>Syncing with parent…</span>
			</div>
			<template v-else>
				<LiveFrm v-if="isFrm" :client="client" :diam="80" :color-scale="frmColorScale" :point-size="pointSize" :point-stride="initStride" :axis="frmAxis"
					@climits="onFrmClimits" />
				<div v-else-if="isPolar" class="syncing">Polar pop-out shows a finished/replayed cut — open it from the embedded panel once a cut is done.</div>
				<LiveForcePlot v-else-if="mode === 'time'" :client="client" :channels="channels" :window-sec="viewWindowSec" />
				<LiveFft v-else-if="mode === 'fft' || mode === 'psd'" :client="client" :channels="channels" :scale="mode === 'psd' ? 'psd' : 'amp'" />
				<LiveSpectrogram v-else-if="mode === 'spectrogram'" :client="client" :channels="channels" :window-sec="viewWindowSec" />
				<LiveWaterfall v-else-if="mode === 'waterfall'" :client="client" :channels="channels" :window-sec="viewWindowSec" />
			</template>
		</div>
	</div>
</template>

<style scoped>
.live-window { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; row-gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 90%, transparent); }
.rec-dot { width: 10px; height: 10px; border-radius: 50%; background: #64748b; flex-shrink: 0; }
.rec-dot.live { background: #ef4444; animation: live-pulse 1.4s infinite; }
.title { font-weight: 600; font-size: var(--fs-lg); flex-shrink: 0; }
.title-slot { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 10px; }
.state { font-size: var(--fs-xs); letter-spacing: 0.01em; color: var(--text-dim); flex-shrink: 0; }
.state.recording { color: var(--warn); } .state.done { color: var(--ok); } .state.error { color: var(--danger); }
.cm { padding: 4px 8px; font-size: var(--fs-sm); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }

/* Channel controls — the same as record/panels/ForcePanel.vue's toolbar, so behaviour and look
   stay identical between the embedded panel and its pop-out. */
.chips { display: flex; gap: 5px; flex-shrink: 0; }
.subwrap { position: relative; flex-shrink: 0; }
.sub-btn.on { --c: var(--accent); }
.subpop { position: absolute; top: 30px; left: 0; z-index: 40; min-width: 118px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 9px; padding: 4px; box-shadow: 0 12px 34px rgba(0,0,0,0.3); }
.subopt { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 7px; font-size: var(--fs-sm); color: var(--text); background: transparent; border: none; border-radius: 6px; cursor: pointer; text-align: left; }
.subopt:hover { background: var(--surface-2); }
.subopt.on { color: var(--text); font-weight: 600; }
.subopt .dot { width: 9px; height: 9px; border-radius: 50%; }
.subopt .tick { margin-left: auto; font-size: var(--icon-xs); color: var(--ok); }
.mono-hint { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-dim); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 3px 7px; flex-shrink: 0; }
.tw-row { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.tw-row input[type="range"] { width: 80px; accent-color: var(--accent); }
.tw-num { width: 42px !important; text-align: center; padding: 3px 2px !important; font-size: var(--fs-xs) !important; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; color: var(--text); }
.tw-unit { font-size: var(--fs-xs); color: var(--text-dim); }

.conn { display: inline-flex; color: var(--text-dim); }
.conn.ok { color: var(--ok); }
.conn .material-symbols-rounded { font-size: var(--icon-md); }
.readouts { margin-left: auto; display: flex; align-items: baseline; gap: 6px; font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.readouts b { font-size: var(--fs-lg); color: var(--text); }
.readouts b.fz { color: var(--fz-ink); }
.readouts b.cut { color: var(--text); font-size: var(--fs-md); }
.syncing { display: flex; align-items: center; justify-content: center; gap: 8px; height: 100%; color: var(--text-dim); font-size: var(--fs-md); }
.body { flex: 1; min-height: 0; padding: 12px; overflow: hidden; }
.body > * { height: 100%; }
</style>
