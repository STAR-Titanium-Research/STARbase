<script setup lang="ts">
// The stage of a tooling record page: an interactive 3D view of the tool box, its inserts and their edges,
// or a 2D grid when WebGL is missing, the stage is narrow, or the viewer prefers it. Both views only
// emit `select`; the page turns that into a route. three.js loads only here, through import(), so it
// stays out of the entry chunk.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { focusParent, type ToolingFocus, type ToolingModel } from '@d1/ui';
import SlotGrid2D from './SlotGrid2D.vue';
import { targetToFocus, type PickTarget } from './scene/pick';
import { hoverLabel, NAV_KEYS, stepFocus, unplacedEdges, type NavKey } from './stageNav';
import { hasWebGL } from './webgl';
import type { ToolingScene } from './scene/toolingScene'; // type only: erased, three.js is not imported here

const props = defineProps<{ model: ToolingModel; focus: ToolingFocus; nextFresh: { insertId: string; edgeId: string } | null }>();
const emit = defineEmits<{ select: [focus: ToolingFocus] }>();

const MIN_3D_WIDTH = 600;
const LARGE_BOX = 60;

const root = ref<HTMLElement | null>(null);
const viewEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const overlayEl = ref<HTMLElement | null>(null);

const width = ref(0);
const webgl = ref(false);
const failed = ref(false); // the 3D scene could not start, or its context was lost
const prefer2d = ref(false);
const loading = ref(false);
const hover = ref<{ text: string; x: number; y: number } | null>(null);

const use3d = computed(() => webgl.value && !failed.value && !prefer2d.value && width.value >= MIN_3D_WIDTH);
const canToggle = computed(() => webgl.value && !failed.value && width.value >= MIN_3D_WIDTH);
const parent = computed(() => focusParent(props.focus));
const unplaced = computed(() => unplacedEdges(props.model, props.focus));
const empty = computed(() => props.model.inserts.length === 0);
const large = computed(() => props.model.inserts.length > LARGE_BOX);

const focusKey = (f: ToolingFocus): string => (f.kind === 'box' ? 'box' : f.kind === 'insert' ? `i:${f.insertId}` : `e:${f.insertId}:${f.edgeId}`);
const nextKey = (n: { insertId: string; edgeId: string } | null): string => (n ? `${n.insertId}:${n.edgeId}` : '');

let scene: ToolingScene | null = null;
let token = 0;
let unmounted = false;
let observer: ResizeObserver | null = null;

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
	} catch {
		if (mine === token) { failed.value = true; loading.value = false; }
		return;
	}
	if (mine !== token || unmounted || !use3d.value) return;
	let s: ToolingScene;
	try {
		s = new mod.ToolingScene(canvas, overlay);
	} catch {
		failed.value = true;
		loading.value = false;
		return;
	}
	s.onPick((t: PickTarget) => { grab(); emit('select', targetToFocus(t)); });
	s.onHover((t, x, y) => {
		hover.value = t ? { text: hoverLabel(props.model, t), x, y } : null;
	});
	s.onContextLost(() => { failed.value = true; });
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
	if (typeof ResizeObserver === 'function' && viewEl.value) {
		observer = new ResizeObserver((entries) => {
			width.value = Math.round(entries[0]?.contentRect.width ?? width.value);
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

function select(f: ToolingFocus | null): void {
	if (f) emit('select', f);
}

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
		<div ref="viewEl" class="tstage__view" :class="{ flat: !use3d }">
			<template v-if="use3d">
				<canvas ref="canvasEl" class="tstage__canvas" aria-hidden="true" @pointerdown="grab"></canvas>
				<div ref="overlayEl" class="tstage__labels" @pointerdown="grab"></div>
				<div v-if="loading" class="tstage__skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
				<div v-if="hover" class="d1-tstage-tip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }">{{ hover.text }}</div>
			</template>
			<SlotGrid2D v-else :model="model" :focus="focus" :next-fresh="nextFresh" @select="select" />

			<div class="tstage__tools">
				<button v-if="parent" type="button" class="tool" title="Up one level (Esc)" @click="select(parent)">&#8593; Up</button>
				<button v-if="use3d" type="button" class="tool" title="Fit the view to the selection" @click="scene?.resetView()">Reset view</button>
				<button v-if="canToggle" type="button" class="tool" :aria-pressed="prefer2d" @click="prefer2d = !prefer2d">
					{{ prefer2d ? '3D view' : '2D grid' }}
				</button>
			</div>
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

.tstage__view {
	position: relative;
	height: 420px;
	min-height: 0;
	background: radial-gradient(
		ellipse 80% 70% at 50% 38%,
		color-mix(in srgb, var(--d1-surface, var(--theme--background)) 55%, var(--d1-tile, var(--theme--background-subdued))),
		var(--d1-tile, var(--theme--background-subdued)) 72%
	);
}
.tstage__view.flat { height: auto; min-height: 240px; }
.tstage__canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; outline: none; }
.tstage__labels { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }

.tstage__tools { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; z-index: 2; }
.tool {
	height: 28px;
	padding: 0 11px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 8px;
	background: color-mix(in srgb, var(--d1-surface, var(--theme--background)) 82%, transparent);
	backdrop-filter: blur(6px);
	color: var(--theme--foreground);
	font-family: inherit;
	font-size: var(--fs-sm, 12px);
	font-weight: 600;
	line-height: 1;
	cursor: pointer;
	transition: border-color 0.12s ease, background 0.12s ease;
}
.tool:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.tool:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.tool[aria-pressed='true'] { background: var(--d1-tint, var(--theme--primary-background)); }

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

.tstage__skeleton { position: absolute; inset: 0; display: grid; place-items: center; grid-auto-flow: column; gap: 14px; pointer-events: none; }
.tstage__skeleton span {
	width: 22%;
	max-width: 160px;
	aspect-ratio: 1.5;
	border-radius: 14px;
	background: color-mix(in srgb, var(--theme--foreground) 8%, transparent);
	animation: tstage-pulse 1.3s ease-in-out infinite;
}
.tstage__skeleton span:nth-child(2) { animation-delay: 0.15s; }
.tstage__skeleton span:nth-child(3) { animation-delay: 0.3s; }
@keyframes tstage-pulse { 50% { opacity: 0.45; } }

.tstage__foot {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 18px;
	padding: 8px 14px;
	border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	font-size: var(--fs-sm, 12px);
	color: var(--d1-dim, var(--theme--foreground-subdued));
}
.legend { display: flex; gap: 14px; margin: 0; padding: 0; list-style: none; }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--d1-dim, var(--theme--foreground-subdued)); }
.dot.ok { background: var(--d1-ok, var(--theme--success)); }
.dot.warn { background: var(--d1-warn, var(--theme--warning)); }
.chips { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
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

<!-- Pills and the hover tip are created imperatively inside the scene's overlay, so their styles are global. -->
<style>
.d1-tstage-pill {
	position: absolute;
	left: 0;
	top: 0;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 20px;
	padding: 0 8px 0 6px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 999px;
	background: color-mix(in srgb, var(--d1-surface, var(--theme--background)) 88%, transparent);
	backdrop-filter: blur(6px);
	box-shadow: var(--d1-shadow, 0 2px 6px rgb(0 0 0 / 0.1));
	color: var(--theme--foreground);
	font: 600 var(--fs-xs, 11px) / 1 var(--theme--fonts--sans--font-family, 'Inter', system-ui, sans-serif);
	font-variant-numeric: tabular-nums;
	letter-spacing: 0.01em;
	white-space: nowrap;
	pointer-events: none;
	will-change: transform;
	animation: d1-tstage-pill-in 0.18s ease-out;
}
button.d1-tstage-pill { pointer-events: auto; cursor: pointer; padding-inline: 6px 8px; }
button.d1-tstage-pill:hover { border-color: var(--d1-accent, var(--theme--primary)); }
button.d1-tstage-pill:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.d1-tstage-pill__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-tstage-pill[data-tone='ok'] .d1-tstage-pill__dot { background: var(--d1-ok, var(--theme--success)); }
.d1-tstage-pill[data-tone='warn'] .d1-tstage-pill__dot { background: var(--d1-warn, var(--theme--warning)); }
.d1-tstage-pill[data-tone='accent'] .d1-tstage-pill__dot { background: var(--d1-accent, var(--theme--primary)); }
.d1-tstage-pill[data-tone='none'] .d1-tstage-pill__dot { display: none; }
.d1-tstage-pill[data-tone='none'] { padding-inline: 8px; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-tstage-pill.is-selected {
	border-color: var(--d1-accent, var(--theme--primary));
	background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 16%, var(--d1-surface, var(--theme--background)));
}
.d1-tstage-tip {
	position: absolute;
	z-index: 20000;
	transform: translate(12px, -34px);
	padding: 5px 10px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 8px;
	background: var(--d1-surface, var(--theme--background));
	box-shadow: var(--d1-shadow, 0 2px 6px rgb(0 0 0 / 0.1));
	color: var(--theme--foreground);
	font: 600 var(--fs-sm, 12px) / 1.2 var(--theme--fonts--sans--font-family, 'Inter', system-ui, sans-serif);
	white-space: nowrap;
	pointer-events: none;
}
@keyframes d1-tstage-pill-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
	.d1-tstage-pill { animation: none; }
}
</style>
