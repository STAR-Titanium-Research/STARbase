<script setup lang="ts">
// Live waterfall: recent spectra of ONE channel stacked with a vertical offset — newest at the
// front (bottom), older frames receding upward and fading. Drawn from the rolling client.fftHistory.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RecordClient } from './liveClient';
import { channelColor } from './types';
import { theme } from '../theme';
import { DEFAULT_WINDOW_SEC } from './plotWindow';

const props = withDefaults(defineProps<{ client: RecordClient; channels?: string[]; windowSec?: number }>(), { windowSec: DEFAULT_WINDOW_SEC });
const canvasEl = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let ro: ResizeObserver | null = null;
// The backend publishes a spectrum roughly every 0.3s (session.py's fft throttle) — convert the
// user-facing time window into a frame count, same as the spectrogram, instead of a fixed count.
const FFT_PUBLISH_HZ = 1 / 0.3;
const maxFrames = computed(() => Math.max(2, Math.round(props.windowSec * FFT_PUBLISH_HZ)));

const chan = computed(() => {
	void props.client.fftSeq.value; // client.fft isn't reactive; see LiveFft.vue's chans
	const avail = props.client.fft ? Object.keys(props.client.fft.spectra) : [];
	const pick = (props.channels || []).find((c) => avail.includes(c));
	return pick || props.client.fft?.axis || avail[0] || 'Fz';
});

function resize() {
	const c = canvasEl.value; if (!c) return;
	const r = c.getBoundingClientRect();
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	c.width = Math.max(1, Math.floor(r.width * dpr));
	c.height = Math.max(1, Math.floor(r.height * dpr));
	ctx = c.getContext('2d');
	if (ctx) ctx.scale(dpr, dpr);
	draw();
}

function draw() {
	const c = canvasEl.value; if (!c || !ctx) return;
	const W = c.clientWidth, H = c.clientHeight;
	const plotBg = getComputedStyle(document.documentElement).getPropertyValue('--plot-bg').trim() || '#0b1020';
	ctx.clearRect(0, 0, W, H);
	ctx.fillStyle = plotBg; ctx.fillRect(0, 0, W, H);
	const ch = chan.value;
	const f = props.client.fft?.f;
	const all = props.client.fftHistory.filter((h) => h.spectra[ch] && h.spectra[ch].length);
	const frames = all.slice(-maxFrames.value);
	if (!f || frames.length < 2) {
		ctx.fillStyle = 'rgba(148,163,184,0.7)'; ctx.font = '12px system-ui';
		ctx.fillText('accumulating waterfall…', 12, H / 2);
		return;
	}
	const fmax = f[f.length - 1] || 1;
	let amax = 1e-9;
	for (const fr of frames) { const s = fr.spectra[ch]; for (const a of s) if (a > amax) amax = a; }

	const top = 18, bottom = H - 16;
	const bandH = (bottom - top);         // vertical span the stack occupies
	const traceH = bandH * 0.32;          // height of a single spectrum trace
	const base = channelColor(ch, theme.value) || '#38bdf8';
	// oldest first so newer traces paint over older ones
	for (let k = 0; k < frames.length; k++) {
		const s = frames[k].spectra[ch];
		const age = (frames.length - 1 - k) / (frames.length - 1); // 0 newest … 1 oldest
		const yBase = top + age * (bandH - traceH) + traceH;       // older → higher up
		const alpha = 0.25 + 0.75 * (1 - age);
		ctx.strokeStyle = base; ctx.globalAlpha = alpha; ctx.lineWidth = k === frames.length - 1 ? 1.5 : 1;
		ctx.beginPath();
		for (let i = 0; i < f.length && i < s.length; i++) {
			const x = (f[i] / fmax) * (W - 8) + 4;
			const y = yBase - (s[i] / amax) * traceH;
			i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		}
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
	ctx.fillStyle = base; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
	ctx.fillText(`${ch} waterfall`, 8, 14);
	ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || 'rgba(226,232,240,0.55)';
	ctx.textAlign = 'right';
	ctx.fillText(`${Math.round(fmax)} Hz`, W - 6, H - 4); ctx.textAlign = 'left';
}

watch(() => props.client.fftSeq.value, draw);
watch(chan, draw);
watch(() => props.windowSec, draw);
watch(theme, draw);
onMounted(() => { resize(); ro = new ResizeObserver(resize); if (canvasEl.value) ro.observe(canvasEl.value); });
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
	<div class="live-wf"><canvas ref="canvasEl"></canvas></div>
</template>

<style scoped>
.live-wf { width: 100%; height: 100%; min-height: 140px; border-radius: 8px; overflow: hidden; background: var(--plot-bg); }
.live-wf canvas { width: 100%; height: 100%; display: block; }
</style>
