<script setup lang="ts">
// Live spectrogram: a time × frequency heatmap of ONE channel, built from the rolling spectra the
// backend publishes (client.fftHistory). X = time (older left → newest right), Y = frequency
// (0 bottom → Nyquist top), colour = amplitude (dB). Painted via an offscreen image the size of the
// history grid, then stretched to the canvas. The bins are max-pooled to the canvas's pixel height
// first, so the dB/colour step runs per visible row, not per ~1024 bins squeezed into a few hundred.
import { computed, onMounted, ref, watch } from 'vue';
import type { RecordClient } from './liveClient';
import { useCanvasLifecycle } from './canvasLifecycle';
import { theme } from '../theme';
import { DEFAULT_WINDOW_SEC } from './plotWindow';
import { maxPoolRows } from './spectrumPool';

const props = withDefaults(defineProps<{ client: RecordClient; channels?: string[]; windowSec?: number }>(), { windowSec: DEFAULT_WINDOW_SEC });
// The backend publishes a spectrum roughly every 0.3s (session.py's fft throttle) — convert the
// user-facing time window into a frame count so this behaves the same as the force/FFT plots'
// windowSec control instead of a fixed, non-configurable frame count.
const FFT_PUBLISH_HZ = 1 / 0.3;
const canvasEl = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

const chan = computed(() => {
	void props.client.fftSeq.value; // client.fft isn't reactive; see LiveFft.vue's chans
	const avail = props.client.fft ? Object.keys(props.client.fft.spectra) : [];
	const pick = (props.channels || []).find((c) => avail.includes(c));
	return pick || props.client.fft?.axis || avail[0] || 'Fz';
});

// Amplitude (dB relative to a running max) → RGB (dark-blue → cyan → yellow), inferno-ish.
function color(db: number, out: Uint8ClampedArray, o: number) {
	const t = Math.max(0, Math.min(1, (db + 60) / 60)); // -60..0 dB → 0..1
	const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 * t - 0.4)));
	const g = Math.round(255 * Math.min(1, Math.max(0, 1.6 * t - 0.2)));
	const b = Math.round(255 * Math.min(1, Math.max(0, 1.1 - 1.7 * Math.abs(t - 0.35))));
	out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
}

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
	const c = canvasEl.value; if (!c || !ctx || !offCtx) return;
	const W = c.clientWidth, H = c.clientHeight;
	const plotBg = getComputedStyle(document.documentElement).getPropertyValue('--plot-bg').trim() || '#0b1020';
	ctx.clearRect(0, 0, W, H);
	ctx.fillStyle = plotBg; ctx.fillRect(0, 0, W, H);
	const hist = props.client.fftHistory;
	const ch = chan.value;
	const wanted = Math.max(2, Math.round(props.windowSec * FFT_PUBLISH_HZ));
	const frames = hist.filter((h) => h.spectra[ch] && h.spectra[ch].length).slice(-wanted);
	if (frames.length < 2) {
		ctx.fillStyle = 'rgba(148,163,184,0.7)'; ctx.font = '12px system-ui';
		ctx.fillText('accumulating spectrogram…', 12, H / 2);
		return;
	}
	const nCols = frames.length;
	const rows = Math.min(frames[frames.length - 1].spectra[ch].length, c.height);
	const cols = frames.map((fr) => maxPoolRows(fr.spectra[ch], rows));
	// running max across the visible window for the dB reference
	let amax = 1e-9;
	for (const s of cols) for (let i = 0; i < s.length; i++) if (s[i] > amax) amax = s[i];

	off.width = nCols; off.height = rows;
	const img = offCtx.createImageData(nCols, rows);
	for (let x = 0; x < nCols; x++) {
		const s = cols[x];
		for (let row = 0; row < rows; row++) {
			const a = s[row] || 1e-12;
			const db = 20 * Math.log10(a / amax);
			// image row 0 = top = high freq; flip so low freq sits at the bottom
			color(db, img.data, ((rows - 1 - row) * nCols + x) * 4);
		}
	}
	offCtx.putImageData(img, 0, 0);
	ctx.imageSmoothingEnabled = true;
	ctx.drawImage(off, 0, 0, nCols, rows, 0, 0, W, H);

	// labels
	const f = props.client.fft?.f;
	const fmax = f && f.length ? f[f.length - 1] : 0;
	ctx.fillStyle = 'rgba(226,232,240,0.85)'; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
	ctx.fillText(`${ch} spectrogram`, 8, 14);
	if (fmax) { ctx.fillStyle = 'rgba(226,232,240,0.6)'; ctx.fillText(`${Math.round(fmax)} Hz`, 8, 26); ctx.fillText('0 Hz', 8, H - 6); }
	ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(226,232,240,0.55)'; ctx.fillText('now →', W - 6, H - 6); ctx.textAlign = 'left';
}

watch(() => props.client.fftSeq.value, draw);
watch(() => props.windowSec, draw);
watch(chan, draw);
watch(theme, draw);
useCanvasLifecycle(canvasEl, { resize, repaint: draw });   // also redraws after a hidden window (#189)
onMounted(resize);
</script>

<template>
	<div class="live-spec"><canvas ref="canvasEl"></canvas></div>
</template>

<style scoped>
.live-spec { width: 100%; height: 100%; min-height: 140px; border-radius: 8px; overflow: hidden; background: var(--plot-bg); }
.live-spec canvas { width: 100%; height: 100%; display: block; }
</style>
