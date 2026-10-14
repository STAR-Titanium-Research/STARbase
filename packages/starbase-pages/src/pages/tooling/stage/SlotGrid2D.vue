<script setup lang="ts">
// The 2D view of the stage, used when WebGL is missing, the stage is narrow, or the viewer asks for it.
// Same selection, same contract as the 3D view: it only emits `select`.
import { computed } from 'vue';
import type { ToolingEdge, ToolingFocus, ToolingInsert, ToolingModel } from '@d1/ui';
import { faces, outline2d } from './outline2d';
import { freshCaption, gridSlots, STATE_LABEL } from './slots2d';

const props = defineProps<{
	model: ToolingModel;
	focus: ToolingFocus;
	nextFresh: { insertId: string; edgeId: string } | null;
}>();
const emit = defineEmits<{ select: [focus: ToolingFocus] }>();

const grid = computed(() => gridSlots(props.model));
const insert = computed<ToolingInsert | null>(() =>
	props.focus.kind === 'box' ? null : props.model.inserts.find((i) => i.id === (props.focus as { insertId: string }).insertId) ?? null);
const drawing = computed(() => outline2d(props.model.geometry, props.model.outline));
const selectedEdge = computed(() => (props.focus.kind === 'edge' ? props.focus.edgeId : null));

const FACE_TITLE = { top: 'Top face', bottom: 'Underside, seen from above' } as const;

function edgesOn(face: 'top' | 'bottom'): ToolingEdge[] {
	return insert.value?.edges.filter((e) => e.placement?.face === face) ?? [];
}
const label = (e: ToolingEdge): string => e.letter ?? e.identifier;
const edgeName = (e: ToolingEdge): string => `Edge ${label(e)}, ${e.used ? 'used' : 'fresh'}${e.id === props.nextFresh?.edgeId ? ', next fresh edge' : ''}`;

function pickInsert(i: ToolingInsert | null): void {
	if (i) emit('select', { kind: 'insert', insertId: i.id });
}
function pickEdge(e: ToolingEdge): void {
	if (insert.value) emit('select', { kind: 'edge', insertId: insert.value.id, edgeId: e.id });
}
</script>

<template>
	<div class="grid2d">
		<div v-if="!insert" class="slots" :style="{ '--cols': grid.columns }" role="group" aria-label="Slots of this tool box">
			<template v-for="s in grid.slots" :key="s.key">
				<button
					v-if="s.insert"
					type="button"
					class="slot"
					:class="[s.insert.state, { next: s.insert.id === nextFresh?.insertId }]"
					:aria-label="`Insert ${s.label}, ${STATE_LABEL[s.insert.state]}, ${freshCaption(s.insert)}`"
					@click="pickInsert(s.insert)"
				>
					<span class="slot-top">
						<span class="slot-num">{{ s.label }}</span>
						<span class="dot" aria-hidden="true"></span>
					</span>
					<span class="slot-sub">{{ freshCaption(s.insert) }}</span>
					<span v-if="s.insert.id === nextFresh?.insertId" class="slot-next">next fresh</span>
				</button>
				<div v-else class="slot empty" role="img" :aria-label="`Slot ${s.label}, empty`"><span class="slot-num">{{ s.label }}</span></div>
			</template>
		</div>

		<div v-else class="faces" :class="{ two: faces(model.geometry).length > 1 }">
			<figure v-for="face in faces(model.geometry)" :key="face" class="face">
				<figcaption>{{ FACE_TITLE[face] }}</figcaption>
				<svg :viewBox="drawing.viewBox" role="group" :aria-label="FACE_TITLE[face]">
					<path :d="drawing.path" class="body" />
					<circle v-if="drawing.hole" cx="0" cy="0" :r="drawing.hole.r" class="hole" />
					<path v-if="face === 'top' && drawing.mark" :d="drawing.mark" class="mark" />
					<g
						v-for="e in edgesOn(face)"
						:key="e.id"
						role="button"
						tabindex="0"
						class="edge"
						:class="[e.used ? 'used' : 'fresh', { sel: e.id === selectedEdge, next: e.id === nextFresh?.edgeId }]"
						:aria-label="edgeName(e)"
						:aria-pressed="e.id === selectedEdge"
						:transform="`translate(${drawing.nose(e.placement!.corner).x} ${drawing.nose(e.placement!.corner).y})`"
						@click="pickEdge(e)"
						@keydown.enter.prevent="pickEdge(e)"
						@keydown.space.prevent="pickEdge(e)"
					>
						<circle r="2.05" />
						<text text-anchor="middle" dominant-baseline="central" y="0.12">{{ label(e) }}</text>
					</g>
				</svg>
			</figure>
		</div>
	</div>
</template>

<style scoped>
.grid2d {
	box-sizing: border-box;
	width: 100%;
	min-height: 100%;
	display: flex;
	flex-direction: column;
	padding: 14px;
	font-family: var(--theme--fonts--sans--font-family, 'Inter', system-ui, sans-serif);
	color: var(--theme--foreground);
}

.slots {
	display: grid;
	grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
	grid-auto-rows: minmax(64px, 1fr);
	gap: 8px;
	flex: 1;
	width: 100%;
}
.slot {
	position: relative;
	display: flex;
	flex-direction: column;
	gap: 2px;
	align-items: flex-start;
	min-width: 0;
	padding: 10px 12px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 10px;
	background: var(--d1-surface, var(--theme--background));
	color: inherit;
	font: inherit;
	text-align: left;
	box-shadow: var(--d1-shadow, none);
}
button.slot { cursor: pointer; transition: border-color 0.12s ease, transform 0.12s ease; }
button.slot:hover { border-color: var(--d1-accent, var(--theme--primary)); }
button.slot:active { transform: translateY(1px); }
button.slot:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.slot.empty {
	border-style: dashed;
	background: transparent;
	box-shadow: none;
	color: var(--d1-dim, var(--theme--foreground-subdued));
}
.slot-top { display: flex; align-items: center; gap: 8px; }
.slot-num { font-size: var(--fs-lg, 15px); font-weight: 700; font-variant-numeric: tabular-nums; }
.slot-sub { font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.slot-next {
	margin-top: 4px;
	padding: 1px 7px;
	border-radius: 999px;
	background: var(--d1-tint, var(--theme--primary-background));
	color: var(--d1-accent, var(--theme--primary));
	font-size: var(--fs-xs, 11px);
	font-weight: 600;
}
.slot.next { border-color: var(--d1-accent, var(--theme--primary)); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--d1-dim, var(--theme--foreground-subdued)); }
.slot.fresh .dot { background: var(--d1-ok, var(--theme--success)); }
.slot.partly-used .dot { background: var(--d1-warn, var(--theme--warning)); }
.slot.depleted { opacity: 0.6; }

.faces { display: flex; gap: 24px; justify-content: center; flex-wrap: wrap; }
.face { margin: 0; flex: 1 1 280px; max-width: 420px; text-align: center; }
.faces:not(.two) .face { max-width: 360px; }
.face figcaption {
	margin-bottom: 4px;
	font-size: var(--fs-sm, 12px);
	font-weight: 600;
	color: var(--d1-dim, var(--theme--foreground-subdued));
}
svg { width: 100%; max-height: 280px; }
.body {
	fill: color-mix(in srgb, var(--theme--foreground) 14%, var(--d1-tile, var(--theme--background-subdued)));
	stroke: color-mix(in srgb, var(--theme--foreground) 55%, transparent);
	stroke-width: 0.25;
	stroke-linejoin: round;
}
.hole { fill: var(--d1-tile, var(--theme--background-subdued)); stroke: color-mix(in srgb, var(--theme--foreground) 40%, transparent); stroke-width: 0.2; }
.mark { fill: color-mix(in srgb, var(--theme--foreground) 55%, transparent); }
.edge { cursor: pointer; outline: none; }
.edge circle {
	fill: var(--d1-surface, var(--theme--background));
	stroke: var(--d1-dim, var(--theme--foreground-subdued));
	stroke-width: 0.3;
	transition: stroke 0.12s ease, fill 0.12s ease;
}
.edge text { font-size: 2.3px; font-weight: 700; fill: var(--theme--foreground); font-family: inherit; pointer-events: none; }
.edge.fresh circle { stroke: var(--d1-ok, var(--theme--success)); stroke-width: 0.5; }
.edge.used circle { stroke: var(--d1-dim, var(--theme--foreground-subdued)); }
.edge.next circle { stroke-width: 0.8; stroke-dasharray: 0.9 0.5; }
.edge:hover circle, .edge:focus-visible circle { stroke: var(--d1-accent, var(--theme--primary)); }
.edge:focus-visible circle { stroke-width: 0.8; }
.edge.sel circle { fill: var(--d1-accent, var(--theme--primary)); stroke: var(--d1-accent, var(--theme--primary)); }
.edge.sel text { fill: var(--d1-on-accent, var(--theme--primary-foreground)); }
</style>
