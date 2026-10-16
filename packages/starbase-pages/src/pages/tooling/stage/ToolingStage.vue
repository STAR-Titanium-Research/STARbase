<script setup lang="ts">
// The stage of a tooling record page: an interactive 3D view of the tool box, its inserts and their edges,
// or a 2D grid when WebGL is missing, the stage is narrow, or the viewer prefers it. Both views only
// emit `select`; the page turns that into a route. three.js loads only here, through import(), so it
// stays out of the entry chunk.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { focusParent, type ToolingFocus, type ToolingModel } from '@d1/ui';
import './stagePills.css';
import SlotGrid2D from './SlotGrid2D.vue';
import { targetToFocus, type PickTarget } from './scene/pick';
import { focusAnnouncement, hoverLabel, NAV_KEYS, stageFits3d, stepFocus, unplacedEdges, type NavKey } from './stageNav';
import { hasWebGL } from './webgl';
import type { ToolingScene } from './scene/toolingScene'; // type only: erased, three.js is not imported here

const props = defineProps<{ model: ToolingModel; focus: ToolingFocus; nextFresh: { insertId: string; edgeId: string } | null }>();
const emit = defineEmits<{ select: [focus: ToolingFocus] }>();

const LARGE_BOX = 60;

const root = ref<HTMLElement | null>(null);
const viewEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const overlayEl = ref<HTMLElement | null>(null);

const width = ref(0);
const height = ref(0);
const webgl = ref(false);
const failed = ref(false); // the 3D scene could not start, or its context was lost
const prefer2d = ref(false);
const canvasKey = ref(0); // a new key is a new canvas: a lost WebGL context cannot be revived on the same one
const loading = ref(false);
const hover = ref<{ text: string; x: number; y: number } | null>(null);

const roomFor3d = computed(() => stageFits3d(width.value, height.value));
const use3d = computed(() => webgl.value && !failed.value && !prefer2d.value && roomFor3d.value);
const canToggle = computed(() => webgl.value && !failed.value && roomFor3d.value);
const parent = computed(() => focusParent(props.focus));
const unplaced = computed(() => unplacedEdges(props.model, props.focus));
const announcement = computed(() => focusAnnouncement(props.model, props.focus));
const empty = computed(() => props.model.inserts.length === 0);
const large = computed(() => props.model.inserts.length > LARGE_BOX);

const focusKey = (f: ToolingFocus): string => (f.kind === 'box' ? 'box' : f.kind === 'insert' ? `i:${f.insertId}` : `e:${f.insertId}:${f.edgeId}`);
const nextKey = (n: { insertId: string; edgeId: string } | null): string => (n ? `${n.insertId}:${n.edgeId}` : '');

let scene: ToolingScene | null = null;
let token = 0;
let unmounted = false;
let observer: ResizeObserver | null = null;
let recoveries: number[] = []; // when the context was lost lately

async function start(): Promise<void> {
	const mine = ++token;
	loading.value = true;
	await nextTick(); // the canvas exists once use3d is true
	const canvas = canvasEl.value;
	const overlay = overlayEl.value;
	if (!canvas || !overlay) { loading.value = false; return; }
	let mod: typeof import('./scene/toolingScene');
	try {
		mod = await import('./scene/toolingScene');
	} catch (e) {
		console.warn('[tooling stage] the 3D scene could not be loaded', e);
		if (mine === token) { failed.value = true; loading.value = false; }
		return;
	}
	if (mine !== token || unmounted || !use3d.value) return;
	let s: ToolingScene;
	try {
		s = new mod.ToolingScene(canvas, overlay);
	} catch (e) {
		console.warn('[tooling stage] the 3D scene could not start', e);
		failed.value = true;
		loading.value = false;
		return;
	}
	s.onPick((t: PickTarget) => { grab(); select(targetToFocus(t)); });
	s.onHover((t, x, y) => {
		hover.value = t ? { text: hoverLabel(props.model, t), x, y } : null;
	});
	s.onContextLost(() => {
		// The browser took the GPU context away (memory pressure, a GPU reset, many tabs). Start again on a fresh canvas
		// rather than dropping to the 2D grid for good; after three losses in 30 s give up.
		console.warn('[tooling stage] the WebGL context was lost');
		const now = Date.now();
		recoveries = recoveries.filter((t) => now - t < 30000);
		if (unmounted || recoveries.length >= 3) { failed.value = true; return; }
		recoveries.push(now);
		stop();
		canvasKey.value++;
		void start();
	});
	s.setModel(props.model);
	s.setFocus(props.focus);
	s.setNextFresh(props.nextFresh);
	s.resize();
	scene = s;
	loading.value = false;
}

function stop(): void {
	token++;
	scene?.dispose();
	scene = null;
	hover.value = null;
	loading.value = false;
}

watch(use3d, (on) => { if (on) void start(); else stop(); }, { flush: 'post' });
watch(() => props.model, (m) => scene?.setModel(m));
watch(() => focusKey(props.focus), () => scene?.setFocus(props.focus));
watch(() => nextKey(props.nextFresh), () => scene?.setNextFresh(props.nextFresh));

onMounted(() => {
	webgl.value = hasWebGL();
	width.value = viewEl.value?.clientWidth ?? 0;
	height.value = viewEl.value?.clientHeight ?? 0;
	if (typeof ResizeObserver === 'function' && viewEl.value) {
		observer = new ResizeObserver((entries) => {
			width.value = Math.round(entries[0]?.contentRect.width ?? width.value);
			height.value = Math.round(entries[0]?.contentRect.height ?? height.value);
			scene?.resize();
		});
		observer.observe(viewEl.value);
	}
});

onBeforeUnmount(() => {
	unmounted = true;
	observer?.disconnect();
	stop();
});

// Selecting can remove the element that had the keyboard focus (a slot button in the 2D grid, the Up button, an
// edge that is no longer drawn), which drops focus to <body> and ends the arrow keys and Esc. So after every
// select, once the page has moved the focus (the route changes a little later than the emit), the stage root
// takes the focus back if it is not inside the stage any more.
let refocusUntil = 0;
function refocus(): void {
	const el = root.value;
	if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
}

function select(f: ToolingFocus | null): void {
	if (!f) return;
	emit('select', f);
	refocusUntil = Date.now() + 1500;
	void nextTick(refocus);
}
watch(() => focusKey(props.focus), () => {
	if (Date.now() >= refocusUntil) return;
	refocusUntil = 0;
	refocus();
}, { flush: 'post' });

function selectEdge(edgeId: string): void {
	if (props.focus.kind !== 'box') emit('select', { kind: 'edge', insertId: props.focus.insertId, edgeId });
}

function onKeydown(e: KeyboardEvent): void {
	if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
	const el = e.target as HTMLElement | null;
	if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
	let next: ToolingFocus | null = null;
	if (e.key === 'Escape') next = parent.value;
	else if (NAV_KEYS.includes(e.key)) next = stepFocus(props.model, props.focus, e.key as NavKey, e.shiftKey);
	else return;
	// Keys the stage owns are handled even when there is nowhere to go, so the page does not scroll on arrows.
	if (e.key !== 'Escape' || next) e.preventDefault();
	select(next);
}

function grab(): void {
	root.value?.focus({ preventScroll: true });
}
</script>

<template>
	<section
		ref="root"
		class="tstage"
		tabindex="0"
		role="group"
		aria-label="Tool box view"
		aria-describedby="tstage-keys"
		@keydown="onKeydown"
	>
		<div class="tstage__bar">
			<button v-if="parent" type="button" class="tool" title="Up one level (Esc)" aria-label="Up one level" @click="select(parent)">
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>Up
			</button>
			<span v-else class="tstage__hint">{{ empty ? 'No inserts' : 'Pick an insert' }}</span>
			<span class="tstage__spacer"></span>
			<button v-if="use3d" type="button" class="tool icon" title="Reset view" aria-label="Reset view" @click="scene?.resetView()">
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V3.5A1.5 1.5 0 0 1 3.5 2H6M10 2h2.5A1.5 1.5 0 0 1 14 3.5V6M14 10v2.5a1.5 1.5 0 0 1-1.5 1.5H10M6 14H3.5A1.5 1.5 0 0 1 2 12.5V10" /><circle cx="8" cy="8" r="1.6" /></svg>
			</button>
			<button
				v-if="canToggle"
				type="button"
				class="tool icon"
				:title="prefer2d ? '3D view' : '2D grid'"
				:aria-label="prefer2d ? '3D view' : '2D grid'"
				:aria-pressed="prefer2d"
				@click="prefer2d = !prefer2d"
			>
				<svg v-if="prefer2d" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 14 5v6l-6 3.5L2 11V5zM2 5l6 3.5L14 5M8 8.5v6" /></svg>
				<svg v-else viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
			</button>
		</div>

		<div ref="viewEl" class="tstage__view" :class="{ flat: !use3d }">
			<template v-if="use3d">
				<canvas :key="canvasKey" ref="canvasEl" class="tstage__canvas" aria-hidden="true" @pointerdown="grab"></canvas>
				<div ref="overlayEl" class="tstage__labels" @pointerdown="grab"></div>
				<div v-if="loading" class="tstage__skeleton" aria-hidden="true"><span v-for="n in 8" :key="n"></span></div>
				<div v-if="hover" class="d1-tstage-tip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }">{{ hover.text }}</div>
			</template>
			<SlotGrid2D v-else :model="model" :focus="focus" :next-fresh="nextFresh" @select="select" />
			<div v-if="empty" class="tstage__empty">No inserts visible to you</div>
		</div>

		<div class="tstage__foot">
			<ul class="legend" aria-label="Colour key">
				<li><i class="dot ok"></i>fresh</li>
				<li><i class="dot warn"></i>part used</li>
				<li><i class="dot dim"></i>used</li>
			</ul>
			<div v-if="unplaced.length" class="chips">
				<span class="note">Position unknown:</span>
				<button v-for="e in unplaced" :key="e.id" type="button" class="chip" @click="selectEdge(e.id)">
					{{ e.letter ?? e.identifier ?? e.code }}<span class="chip-state"> &middot; {{ e.used ? 'used' : 'fresh' }}</span>
				</button>
			</div>
			<span v-if="!model.geometry.recognised" class="note">Shape not recognised from the ISO designation; drawn as a generic polygon.</span>
			<span v-if="large && use3d" class="note">
				More than {{ LARGE_BOX }} inserts.
				<button type="button" class="link" @click="prefer2d = true">Show the 2D grid</button>
			</span>
		</div>
		<p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>
		<p id="tstage-keys" class="sr-only">Arrow keys step between inserts or edges, Page Up and Page Down move between inserts, Escape goes up a level.</p>
	</section>
</template>

<style scoped>
.tstage {
	position: relative;
	display: flex;
	flex-direction: column;
	min-width: 0;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px);
	background: var(--d1-tile, var(--theme--background-subdued));
	box-shadow: var(--d1-shadow, none);
	overflow: hidden;
	color: var(--theme--foreground);
	font-family: var(--theme--fonts--sans--font-family, 'Inter', system-ui, sans-serif);
}
.tstage:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }

.tstage__bar {
	display: flex;
	align-items: center;
	gap: 6px;
	height: 38px;
	padding: 0 8px 0 10px;
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
.tstage__spacer { flex: 1; }
.tstage__hint { font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.tool {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	height: 26px;
	padding: 0 10px 0 7px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 8px;
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	font-family: inherit;
	font-size: var(--fs-sm, 12px);
	font-weight: 600;
	line-height: 1;
	cursor: pointer;
	transition: border-color 0.12s ease, background 0.12s ease;
}
.tool.icon { width: 28px; padding: 0; }
.tool svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.tool:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.tool:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.tool[aria-pressed='true'] { background: var(--d1-tint, var(--theme--primary-background)); }

/* The stage is a tall, portrait tile: up to 560px, but short enough that the rail's identity block, the bar
   above and the key below still fit in the window under the header (the page sets --d1-sticky-top). Never
   under 380px, the smallest the 3D view is worth drawing in. */
.tstage__view {
	position: relative;
	height: clamp(380px, calc(100vh - var(--d1-sticky-top, 70px) - 330px), 560px);
	height: clamp(380px, calc(100dvh - var(--d1-sticky-top, 70px) - 330px), 560px);
	min-height: 0;
	background: radial-gradient(
		ellipse 80% 70% at 50% 38%,
		color-mix(in srgb, var(--d1-surface, var(--theme--background)) 55%, var(--d1-tile, var(--theme--background-subdued))),
		var(--d1-tile, var(--theme--background-subdued)) 72%
	);
}
/* Stacked layout (the tooling page stacks under 840px, RecordLayout late-stack): the stage sits above the panels at full width, shorter. */
@container (max-width: 840px) {
	.tstage__view {
		height: clamp(380px, calc(100vh - var(--d1-sticky-top, 70px) - 240px), 480px);
		height: clamp(380px, calc(100dvh - var(--d1-sticky-top, 70px) - 240px), 480px);
	}
}
.tstage__view.flat { overflow: auto; }
.tstage__canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; outline: none; }
.tstage__labels { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }

.tstage__empty {
	position: absolute;
	left: 50%;
	bottom: 18px;
	transform: translateX(-50%);
	padding: 6px 14px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 999px;
	background: var(--d1-surface, var(--theme--background));
	font-size: var(--fs-sm, 12px);
	color: var(--d1-dim, var(--theme--foreground-subdued));
}

.tstage__skeleton { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(2, 38%); grid-auto-rows: 9%; justify-content: center; align-content: center; gap: 4%; pointer-events: none; }
.tstage__skeleton span {
	border-radius: 12px;
	background: color-mix(in srgb, var(--theme--foreground) 8%, transparent);
	animation: tstage-pulse 1.3s ease-in-out infinite;
}
.tstage__skeleton span:nth-child(even) { animation-delay: 0.15s; }
@keyframes tstage-pulse { 50% { opacity: 0.45; } }

.tstage__foot {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 14px;
	padding: 8px 12px;
	border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	font-size: var(--fs-sm, 12px);
	color: var(--d1-dim, var(--theme--foreground-subdued));
}
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--d1-dim, var(--theme--foreground-subdued)); }
.dot.ok { background: var(--d1-ok, var(--theme--success)); }
.dot.warn { background: var(--d1-warn, var(--theme--warning)); }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
.chip {
	padding: 2px 10px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 999px;
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}
.chip:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.chip-state { font-weight: 400; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.link { padding: 0; border: 0; background: none; color: var(--d1-accent, var(--theme--primary)); font: inherit; text-decoration: underline; cursor: pointer; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (prefers-reduced-motion: reduce) {
	.tstage__skeleton span { animation: none; }
	.tool { transition: none; }
}
</style>
