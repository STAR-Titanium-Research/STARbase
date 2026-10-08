<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { RecordClient } from './liveClient';
import { useCanvasLifecycle } from './canvasLifecycle';
import { channelColor } from './types';
import { theme } from '../theme';

const props = defineProps<{ client: RecordClient; channels?: string[]; scale?: 'amp' | 'psd' }>();
const canvasEl = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;

// MB fits the tick labels (4-14px below the plot) AND the axis title under them; at 22 the
// title was drawn top-aligned 4px above the canvas edge and always clipped to half its height.
const ML = 48, MR = 10, MT = 10, MB = 32;

const chans = computed(() => {
	// client.fft is a plain (non-reactive) field, so without this the pick was cached from the
	// first render — before any spectrum existed — and the default panel drew an empty grid
	// until a channel toggle happened to recompute it.
	void props.client.fftSeq.value;
	const fft = props.client.fft;
	const avail = fft ? Object.keys(fft.spectra) : [];
	const sel = (props.channels && props.channels.length ? props.channels : [fft?.axis || 'Fz']).filter((c) => avail.includes(c));
	return sel.length ? sel : avail.slice(0, 1);
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

function niceStep(range: number, ticks: number): number {
	const raw = range / ticks;
	const mag = Math.pow(10, Math.floor(Math.log10(raw)));
	const r = raw / mag;
	return (r <= 1.5 ? 1 : r <= 3 ? 2 : r <= 7 ? 5 : 10) * mag;
}

function palette() {
	const s = getComputedStyle(document.documentElement);
	return {
		bg: s.getPropertyValue('--plot-bg').trim() || '#0b1020',
		grid: s.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.06)',
		text: s.getPropertyValue('--text-dim').trim() || 'rgba(226,232,240,0.55)',
		textFaint: s.getPropertyValue('--text-faint').trim() || 'rgba(226,232,240,0.45)',
	};
}

function draw() {
	const c = canvasEl.value; if (!c || !ctx) return;
	const CW = c.clientWidth, CH = c.clientHeight;
	const W = CW - ML - MR, H = CH - MT - MB;
	const pal = palette();
	ctx.clearRect(0, 0, CW, CH);
	ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, CW, CH);

	const fft = props.client.fft;
	const f = fft?.f;
	if (!fft || !f || f.length < 2) {
		ctx.fillStyle = pal.text; ctx.font = '12px system-ui';
		ctx.fillText('waiting for spectrum…', ML + 8, MT + H / 2);
		return;
	}
	const fmax = f[f.length - 1] || 1;
	const psd = props.scale === 'psd';
	const drawn = chans.value;

	let amax = 1e-9;
	for (const ch of drawn) { const s = fft.spectra[ch]; if (s) for (const a of s) if (a > amax) amax = a; }
	const floorDb = -60;

	const yOf = (a: number) => {
		if (psd) {
			const db = 20 * Math.log10((a || 1e-12) / amax);
			const n = Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
			return MT + H - n * H;
		}
		const logVal = Math.log10((a || 1e-12) / amax);
		const n = Math.max(0, Math.min(1, (logVal - floorDb / 20) / (-floorDb / 20)));
		return MT + H - n * H;
	};
	const xOf = (freq: number) => ML + (freq / fmax) * W;

	// X-axis ticks (frequency)
	ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
	ctx.strokeStyle = pal.grid; ctx.lineWidth = 1;
	const xStep = niceStep(fmax, Math.max(2, Math.floor(W / 80)));
	for (let freq = 0; freq <= fmax; freq += xStep) {
		if (freq === 0) continue;
		const x = xOf(freq);
		if (x < ML || x > ML + W) continue;
		ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + H); ctx.stroke();
		ctx.fillStyle = pal.text;
		ctx.fillText(freq >= 1000 ? (freq / 1000).toFixed(freq >= 10000 ? 0 : 1) + 'k' : String(Math.round(freq)), x, MT + H + 4);
	}

	// Y-axis ticks
	ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
	if (psd) {
		const dbStep = floorDb <= -40 ? 10 : 5;
		for (let db = floorDb; db <= 0; db += dbStep) {
			const n = (db - floorDb) / -floorDb;
			const y = MT + H - n * H;
			ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + W, y); ctx.stroke();
			ctx.fillStyle = pal.text;
			ctx.fillText(`${db}`, ML - 5, y);
		}
	} else {
		for (let i = 1; i <= 4; i++) {
			const y = MT + (H * i) / 5;
			ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + W, y); ctx.stroke();
		}
	}

	// Plot data
	for (const ch of drawn) {
		const s = fft.spectra[ch]; if (!s) continue;
		ctx.strokeStyle = channelColor(ch, theme.value) || '#38bdf8'; ctx.lineWidth = 1.2; ctx.beginPath();
		for (let i = 0; i < f.length && i < s.length; i++) {
			const x = xOf(f[i]);
			const y = yOf(s[i]);
			i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		}
		ctx.stroke();
	}

	// Axis labels
	ctx.fillStyle = pal.textFaint; ctx.font = '10px system-ui';
	ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
	ctx.fillText('Frequency (Hz)', ML + W / 2, CH - 2);
	ctx.save(); ctx.translate(10, MT + H / 2); ctx.rotate(-Math.PI / 2);
	ctx.textBaseline = 'middle'; ctx.fillText(psd ? 'Power (dB)' : 'Amplitude (N)', 0, 0); ctx.restore();

	// Legend, on a backdrop: amplitudes are normalised to the max, so the traces always reach the
	// top edge the legend sits on.
	ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
	let legendW = 0;
	for (const ch of drawn) legendW += ctx.measureText(ch).width + 12;
	ctx.globalAlpha = 0.85; ctx.fillStyle = pal.bg; ctx.fillRect(ML + 1, MT + 1, legendW + 4, 17); ctx.globalAlpha = 1;
	let lx = ML + 4;
	for (const ch of drawn) {
		ctx.fillStyle = channelColor(ch, theme.value) || '#38bdf8';
		ctx.fillText(ch, lx, MT + 4); lx += ctx.measureText(ch).width + 12;
	}
}

watch(() => props.client.fftSeq.value, draw);
watch(() => props.scale, draw);
// By value: chans now recomputes on every spectrum (it tracks fftSeq), and the fftSeq watcher
// above already redraws for those — this one only needs to catch a changed selection.
watch(() => chans.value.join(), draw);
watch(theme, draw);
useCanvasLifecycle(canvasEl, { resize, repaint: draw });   // also redraws after a hidden window (#189)
onMounted(resize);
</script>

<template>
	<div class="live-fft"><canvas ref="canvasEl"></canvas></div>
</template>

<style scoped>
.live-fft { width: 100%; height: 100%; min-height: 140px; border-radius: 8px; overflow: hidden; background: var(--plot-bg); }
.live-fft canvas { width: 100%; height: 100%; display: block; }
</style>
