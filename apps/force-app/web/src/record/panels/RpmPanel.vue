<script setup lang="ts">
// Live RPM meter: a radial gauge + numeric readout vs the programmed target, plus a rolling
// sparkline of recent RPM. Reads the live stream's rpm each frame (no per-sample reactivity).
import { computed, ref, watch } from 'vue';
import { useWorkspace } from '../workspace';

const w = useWorkspace();
const hist = ref<number[]>([]);
const MAXH = 160;
watch(() => w.client.frameSeq.value, () => {
	if (w.st.state !== 'recording') return;
	hist.value.push(w.st.rpm);
	if (hist.value.length > MAXH) hist.value.shift();
});

const rpm = computed(() => w.st.rpm || 0);
// Resolved by the workspace: the replayed cut's own spindle speed in playback, the configured
// target when recording — so a replay is measured against itself, not against whatever number
// happened to be left in the recording form.
const target = computed(() => w.rpmTarget.value || 0);
const max = computed(() => Math.max(target.value * 1.25, rpm.value * 1.1, 100));
const overTarget = computed(() => target.value > 0 && rpm.value > target.value * 1.02);

// Gauge geometry: a 240° arc from -120°..+120°.
const CX = 100, CY = 96, R = 78, SWEEP = 240, START = -120;
function polar(deg: number, r = R): [number, number] {
	const a = ((deg - 90) * Math.PI) / 180;
	return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}
function arc(a0: number, a1: number, r = R): string {
	const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
	return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}
const frac = computed(() => Math.min(1, rpm.value / max.value));
const valDeg = computed(() => START + SWEEP * frac.value);
const targetDeg = computed(() => START + SWEEP * Math.min(1, target.value / max.value));
// A short pointer riding just inside the arc, not a needle from the centre: the readout lives in
// the centre, and a full-length needle plus hub drew straight through the number and "RPM".
const needle = computed(() => ({ a: polar(valDeg.value, R - 26), b: polar(valDeg.value, R - 9) }));
const targetTick = computed(() => ({ a: polar(targetDeg.value, R + 2), b: polar(targetDeg.value, R - 14) }));

const spark = computed(() => {
	const h = hist.value;
	if (h.length < 2) return '';
	const mx = Math.max(...h, target.value, 1);
	return h.map((v, i) => `${(i / (h.length - 1)) * 200},${38 - (v / mx) * 34}`).join(' ');
});
</script>

<template>
	<div class="rpm-panel">
		<svg viewBox="0 0 200 150" class="gauge">
			<path :d="arc(START, START + SWEEP)" class="track" />
			<path :d="arc(START, valDeg)" class="value" :class="{ over: overTarget }" />
			<line v-if="target > 0" :x1="targetTick.a[0]" :y1="targetTick.a[1]" :x2="targetTick.b[0]" :y2="targetTick.b[1]" class="target" />
			<line :x1="needle.a[0]" :y1="needle.a[1]" :x2="needle.b[0]" :y2="needle.b[1]" class="needle" :class="{ over: overTarget }" />
			<text :x="CX" :y="CY + 6" class="big" :class="{ over: overTarget }">{{ Math.round(rpm) }}</text>
			<text :x="CX" :y="CY + 24" class="unit">RPM</text>
		</svg>
		<div class="foot">
			<span class="target-lbl">target {{ Math.round(target) }}</span>
			<svg viewBox="0 0 200 40" class="spark" preserveAspectRatio="none">
				<polyline :points="spark" />
			</svg>
		</div>
	</div>
</template>

<style scoped>
.rpm-panel { display: flex; flex-direction: column; height: 100%; align-items: center; justify-content: center; gap: 6px; }
.gauge { width: 100%; max-width: 260px; height: auto; }
.track { fill: none; stroke: color-mix(in srgb, var(--text) 9%, transparent); stroke-width: 12; stroke-linecap: round; }
/* DESIGN TEST: was #4ade80 -- the Fy axis colour. This gauge sits feet away from Fx/Fy/Fz
   readouts, so spindle speed was being drawn in a hue that means "Y force" everywhere else in
   the app. Spindle speed is not a force channel; it takes the interface accent instead, and
   green goes back to meaning Fy and only Fy. */
.value { fill: none; stroke: var(--accent); stroke-width: 12; stroke-linecap: round; transition: none; }
.value.over { stroke: #ef4444; }
.target { stroke: var(--text-dim); stroke-width: 2.5; }
/* Theme tokens, not #e2e8f0: the needle and the number were near-white on the light theme's
   near-white panel, i.e. invisible. */
.needle { stroke: var(--text); stroke-width: 3; stroke-linecap: round; }
.needle.over { stroke: #ef4444; }
.big { fill: var(--text); font-size: var(--fs-display); font-weight: 700; text-anchor: middle; font-variant-numeric: tabular-nums; }
.big.over { fill: #f87171; }
.unit { fill: var(--text-dim); font-size: var(--fs-xs); text-anchor: middle; letter-spacing: 0.08em; }
.foot { width: 100%; max-width: 260px; text-align: center; }
/* Neutral, not the warning amber: the target is a reference value, not a state. The sparkline
   takes the gauge's own accent rather than the Fz blue, same reasoning as .value above. */
.target-lbl { font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.spark { width: 100%; height: 40px; }
.spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
</style>
