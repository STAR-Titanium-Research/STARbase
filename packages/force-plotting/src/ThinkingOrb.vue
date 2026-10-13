<script setup lang="ts">
// The app's loading indicator: a dotted orb whose three strands are the Fx/Fy/Fz colours of the
// login brand mark (geometry in thinkingOrb.ts). Drawn on a 2D canvas.
//
// Every orb runs off one shared clock (performance.now), so two on screen turn in step. Each pauses
// while scrolled out of view or while the window is hidden. prefers-reduced-motion slows it to a
// drift rather than stopping it: like the app's other spinners, a frozen one reads as a hang.
//
// Colours come from the axis ink tokens (--fx-ink/--fy-ink/--fz-ink: the login mark's red, green and
// blue, tuned per theme to read on its ground), then --fx/--fy/--fz, then the force app's dark-theme
// values where a host such as Directus defines neither. A canvas doesn't repaint from CSS by itself, so the
// orb watches the root's data-theme/class and re-reads them when the theme flips.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { orbFrame, orbPreset } from './thinkingOrb';

const props = withDefaults(
	defineProps<{
		/** Rendered width and height in CSS px. */
		size?: number;
		/** Accessible name. Pass '' when visible text next to the orb already says what is loading. */
		label?: string;
	}>(),
	{ size: 20, label: 'Loading' },
);

const canvas = ref<HTMLCanvasElement | null>(null);

let ctx: CanvasRenderingContext2D | null = null;
let colours = ['#f87171', '#4ade80', '#60a5fa'];
let ghost = '#8494a8';
let raf = 0;
let running = false;
let onScreen = true;
let io: IntersectionObserver | null = null;
let themeObserver: MutationObserver | null = null;
// Fires when the display scale changes (window dragged to another monitor, Ctrl +/-), so the
// backing store can be resized instead of the orb turning blurry. Re-armed for each new scale.
let dprMq: MediaQueryList | null = null;
const reducedMq = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-reduced-motion: reduce)');
// The same ratio as the CSS spinners' reduced-motion rule in the force app (0.9 s → 2 s a turn).
const REDUCED_SPEED = 0.45;

function readColours() {
	if (!canvas.value) return;
	const cs = getComputedStyle(canvas.value);
	const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
	colours = (['fx', 'fy', 'fz'] as const).map((k, i) => v(`--${k}-ink`, v(`--${k}`, colours[i])));
	ghost = v('--text-dim', v('--theme--foreground-subdued', ghost));
}

function setup() {
	const el = canvas.value;
	if (!el) return;
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	el.width = Math.round(props.size * dpr);
	el.height = Math.round(props.size * dpr);
	ctx = el.getContext('2d');
	ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
	dprMq?.removeEventListener('change', onDprChange);
	dprMq = typeof matchMedia === 'undefined' ? null : matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
	dprMq?.addEventListener('change', onDprChange);
}
function onDprChange() {
	setup();
	refresh();
}

function draw(t: number) {
	if (!ctx) return;
	const size = props.size;
	ctx.clearRect(0, 0, size, size);
	for (const d of orbFrame(size, t, orbPreset(size).opts)) {
		ctx.globalAlpha = d.a;
		ctx.fillStyle = d.strand < 0 ? ghost : colours[d.strand];
		ctx.beginPath();
		ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.globalAlpha = 1;
}

const now = () =>
	(performance.now() / 1000) * orbPreset(props.size).speed * (reducedMq?.matches ? REDUCED_SPEED : 1);

function loop() {
	draw(now());
	if (running) raf = requestAnimationFrame(loop);
}
function start() {
	if (running || !onScreen || document.visibilityState === 'hidden') return;
	running = true;
	raf = requestAnimationFrame(loop);
}
function stop() {
	running = false;
	cancelAnimationFrame(raf);
}
// Paint the current frame now (also when paused off screen) and run if allowed.
function refresh() {
	stop();
	draw(now());
	start();
}

const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());

onMounted(() => {
	readColours();
	setup();
	if (typeof IntersectionObserver !== 'undefined' && canvas.value) {
		// Entries come oldest first; after a quick v-show toggle only the last one is current.
		io = new IntersectionObserver((entries) => {
			onScreen = entries[entries.length - 1].isIntersecting;
			if (onScreen) start();
			else stop();
		});
		io.observe(canvas.value);
	}
	if (typeof MutationObserver !== 'undefined') {
		themeObserver = new MutationObserver(() => {
			readColours();
			refresh();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
	}
	document.addEventListener('visibilitychange', onVisibility);
	reducedMq?.addEventListener('change', refresh);
	refresh();
});

onBeforeUnmount(() => {
	stop();
	io?.disconnect();
	themeObserver?.disconnect();
	dprMq?.removeEventListener('change', onDprChange);
	document.removeEventListener('visibilitychange', onVisibility);
	reducedMq?.removeEventListener('change', refresh);
});

watch(() => props.size, () => {
	setup();
	refresh();
});
</script>

<template>
	<canvas
		ref="canvas"
		class="thinking-orb"
		:style="{ width: size + 'px', height: size + 'px' }"
		:role="label ? 'img' : undefined"
		:aria-label="label || undefined"
		:aria-hidden="label ? undefined : 'true'"
	></canvas>
</template>

<style scoped>
.thinking-orb {
	display: inline-block;
	flex-shrink: 0;
	vertical-align: middle;
}
</style>
