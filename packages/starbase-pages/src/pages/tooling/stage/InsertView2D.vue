<script setup lang="ts">
// The 2D view of one insert (and of one of its edges): one large outline filling the stage, the edge letters on the face being
// shown, a Top | Underside choice for a double-sided insert, and a chip per edge so every letter is reachable without turning
// the insert over. Same contract as the 3D view: it only emits `select`. insertView2d.ts has the pure parts.
import { computed, ref, watch } from 'vue';
import type { ToolingFocus, ToolingInsert, ToolingModel } from '@d1/ui';
import { buildInsertView, FACE_LABEL, type Face } from './insertView2d';

const props = defineProps<{
	model: ToolingModel;
	insert: ToolingInsert;
	focus: ToolingFocus;
	nextFresh: { insertId: string; edgeId: string } | null;
}>();
const emit = defineEmits<{ select: [focus: ToolingFocus] }>();

// The face asked for with the control; the face holding a selected edge wins (insertView2d.faceToShow).
const chosen = ref<Face>('top');
watch(() => props.insert.id, () => { chosen.value = 'top'; });
const nextEdge = computed(() => (props.nextFresh?.insertId === props.insert.id ? props.nextFresh.edgeId : null));
const view = computed(() => buildInsertView(props.model, props.insert, props.focus, nextEdge.value, chosen.value));
const faceOptions = ['top', 'bottom'] as const satisfies readonly Face[];

function show(face: Face): void {
	chosen.value = face;
	// An edge selected on the other face is no longer in the drawing: select the insert so the face the viewer asked for shows.
	if (props.focus.kind === 'edge' && view.value.face !== face) emit('select', { kind: 'insert', insertId: props.insert.id });
}
function pick(edgeId: string): void {
	emit('select', { kind: 'edge', insertId: props.insert.id, edgeId });
}
</script>

<template>
	<div class="insert2d">
		<div v-if="view.doubleSided" class="faces" role="group" aria-label="Face of the insert">
			<button v-for="f in faceOptions" :key="f" type="button" class="face-btn" :class="{ on: view.face === f }" :aria-pressed="view.face === f" @click="show(f)">
				{{ FACE_LABEL[f] }}
			</button>
		</div>

		<svg class="drawing" :viewBox="view.drawing.viewBox" preserveAspectRatio="xMidYMid meet" role="group" :aria-label="`${FACE_LABEL[view.face]} face of the insert`">
			<path :d="view.drawing.path" class="body" />
			<circle v-if="view.drawing.hole" cx="0" cy="0" :r="view.drawing.hole.r" class="hole" />
			<path v-if="view.drawing.mark" :d="view.drawing.mark" class="mark" />
			<g
				v-for="p in view.pills"
				:key="p.edge.id"
				role="button"
				tabindex="0"
				class="pill"
				:class="[p.used ? 'used' : 'fresh', { sel: p.selected, next: p.next }]"
				:aria-label="p.name"
				:aria-pressed="p.selected"
				:transform="`translate(${p.x} ${p.y})`"
				@click="pick(p.edge.id)"
				@keydown.enter.prevent="pick(p.edge.id)"
				@keydown.space.prevent="pick(p.edge.id)"
			>
				<circle r="2.4" />
				<text text-anchor="middle" dominant-baseline="central" y="0.12">{{ p.letter }}</text>
			</g>
		</svg>

		<p v-if="view.caption" class="caption">{{ view.caption }}</p>

		<div v-if="view.chips.length" class="chips" role="group" aria-label="Edges of this insert">
			<button
				v-for="c in view.chips"
				:key="c.edge.id"
				type="button"
				class="chip"
				:class="[c.used ? 'used' : 'fresh', { sel: c.selected, next: c.next }]"
				:aria-label="c.name"
				:aria-pressed="c.selected"
				@click="pick(c.edge.id)"
			>
				<i class="dot" aria-hidden="true"></i>{{ c.text }}<span class="state">{{ c.used ? 'used' : 'fresh' }}</span>
			</button>
		</div>

		<p class="facts">{{ view.facts }}</p>
	</div>
</template>

<style scoped>
.insert2d { display: flex; flex-direction: column; align-items: center; gap: 8px; height: 100%; min-height: 0; }
.faces { display: inline-flex; border: 1px solid var(--s2d-line); border-radius: 8px; overflow: hidden; flex: none; }
.face-btn {
	padding: 3px 14px;
	border: 0;
	background: var(--s2d-surface);
	color: inherit;
	font: inherit;
	font-size: var(--fs-sm, 12px);
	font-weight: 600;
	cursor: pointer;
}
.face-btn + .face-btn { border-left: 1px solid var(--s2d-line); }
.face-btn.on { background: var(--s2d-select); color: #fff; }
.face-btn:focus-visible { outline: 2px solid var(--s2d-select); outline-offset: -2px; }
.drawing { flex: 1; min-height: 0; width: 100%; display: block; }
.body { fill: var(--s2d-body); stroke: var(--s2d-body-line); stroke-width: 0.3; stroke-linejoin: round; }
.hole { fill: var(--s2d-tile); stroke: color-mix(in srgb, var(--theme--foreground) 40%, transparent); stroke-width: 0.2; }
.mark { fill: var(--theme--background); }
.pill { cursor: pointer; outline: none; }
.pill circle { fill: var(--s2d-surface); stroke: var(--s2d-used); stroke-width: 0.35; transition: fill 0.12s ease, stroke 0.12s ease; }
.pill text { font-size: 2.7px; font-weight: 700; fill: var(--theme--foreground); font-family: inherit; pointer-events: none; }
.pill.fresh circle { stroke: var(--s2d-fresh); stroke-width: 0.55; }
.pill.next circle { stroke-dasharray: 0.9 0.5; stroke-width: 0.75; }
.pill:hover circle, .pill:focus-visible circle { stroke: var(--s2d-accent); stroke-width: 0.8; }
.pill.sel circle { fill: var(--s2d-select); stroke: var(--s2d-surface); stroke-width: 0.7; stroke-dasharray: none; }
.pill.sel text { fill: #fff; }
.caption { margin: 0; flex: none; font-size: var(--fs-xs, 11px); color: var(--s2d-dim); text-align: center; }
.chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; flex: none; }
.chip {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 24px;
	padding: 0 10px 0 8px;
	border: 1px solid var(--s2d-line);
	border-radius: 999px;
	background: var(--s2d-surface);
	color: inherit;
	font: inherit;
	font-size: var(--fs-sm, 12px);
	font-weight: 600;
	cursor: pointer;
}
.chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--s2d-used); }
.chip.fresh .dot { background: var(--s2d-fresh); }
.chip .state { font-weight: 500; color: var(--s2d-dim); }
.chip.next { border-style: dashed; border-color: var(--s2d-fresh); }
.chip:hover { border-color: var(--s2d-accent); }
.chip:focus-visible { outline: 2px solid var(--s2d-select); outline-offset: 1px; }
.chip.sel { background: var(--s2d-select); border-color: var(--s2d-select); border-style: solid; color: #fff; }
.chip.sel .state { color: rgb(255 255 255 / 0.85); }
.chip.sel .dot { background: #fff; }
.facts { margin: 0; flex: none; font-size: var(--fs-sm, 12px); color: var(--s2d-dim); text-align: center; }
</style>
