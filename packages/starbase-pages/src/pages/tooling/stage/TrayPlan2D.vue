<script setup lang="ts">
// The 2D view of a tool box: the tray seen from above, one SVG that mirrors the 3D tray (plan2d.ts has the layout). Each
// pocket holds the insert's real outline with a dot per edge; hovering or tabbing to a pocket highlights it, a click or
// Enter selects the insert. Same contract as the 3D view: it only emits `select`.
import { computed } from 'vue';
import type { ToolingFocus, ToolingModel } from '@d1/ui';
import { buildTrayPlan, type PlanPocket } from './plan2d';

const props = defineProps<{ model: ToolingModel; nextFresh: { insertId: string; edgeId: string } | null }>();
const emit = defineEmits<{ select: [focus: ToolingFocus] }>();

const plan = computed(() => buildTrayPlan(props.model, props.nextFresh));

function pick(p: PlanPocket): void {
	if (p.insert) emit('select', { kind: 'insert', insertId: p.insert.id });
}
</script>

<template>
	<svg class="plan" :viewBox="plan.viewBox" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Tool box tray, seen from above">
		<rect class="tray" :x="plan.tray.x" :y="plan.tray.y" :width="plan.tray.w" :height="plan.tray.h" :rx="plan.tray.r" />
		<g
			v-for="p in plan.pockets"
			:key="p.key"
			class="pocket"
			:class="[p.state ?? 'empty', { next: p.next }]"
			:transform="`translate(${p.x} ${p.y})`"
			:role="p.insert ? 'button' : 'img'"
			:tabindex="p.insert ? 0 : undefined"
			:aria-label="p.name"
			@click="pick(p)"
			@keydown.enter.prevent="pick(p)"
			@keydown.space.prevent="pick(p)"
		>
			<rect v-if="p.next" class="next-ring" :x="-p.w / 2 - 1" :y="-p.h / 2 - 1" :width="p.w + 2" :height="p.h + 2" :rx="plan.pocketRadius + 1" />
			<rect class="pocket-rect" :x="-p.w / 2" :y="-p.h / 2" :width="p.w" :height="p.h" :rx="plan.pocketRadius" />
			<template v-if="p.insert">
				<path class="insert-body" :d="plan.outline" />
				<circle v-if="plan.hole" class="hole" :r="plan.hole" />
				<g v-for="d in p.dots" :key="d.key" class="dot" :class="[d.used ? 'used' : 'fresh', { hollow: d.hollow, next: d.next, under: d.face === 'bottom' }]" :transform="`translate(${d.x} ${d.y})`">
					<title>{{ d.name }}</title>
					<circle class="ring" :r="d.r" />
					<circle v-if="d.face === 'bottom'" class="core" :r="d.r * 0.55" />
				</g>
			</template>
		</g>
		<text
			v-for="t in plan.texts"
			:key="t.key"
			class="etch"
			:class="t.kind"
			:x="t.x"
			:y="t.y"
			:style="{ fontSize: `${t.size}px` }"
			text-anchor="middle"
			dominant-baseline="central"
			:textLength="t.length ?? undefined"
			lengthAdjust="spacingAndGlyphs"
		>{{ t.text }}</text>
	</svg>
</template>

<style scoped>
.plan { display: block; width: 100%; height: 100%; min-height: 0; flex: 1; }
.tray { fill: var(--s2d-tray); stroke: color-mix(in srgb, var(--theme--foreground) 18%, var(--s2d-tray)); stroke-width: 0.4; }
.pocket { outline: none; }
.pocket[role='button'] { cursor: pointer; }
.pocket-rect {
	fill: var(--s2d-pocket);
	stroke: var(--s2d-groove);
	stroke-width: 0.5;
	transition: stroke 0.12s ease, stroke-width 0.12s ease;
}
.pocket.empty .pocket-rect { fill: transparent; stroke-dasharray: 1.8 1.3; }
.pocket.depleted .pocket-rect { opacity: 0.7; }
.pocket[role='button']:hover .pocket-rect { stroke: var(--s2d-accent); stroke-width: 0.9; }
.pocket[role='button']:focus-visible .pocket-rect { stroke: var(--s2d-select); stroke-width: 1.1; }
.next-ring { fill: none; stroke: var(--s2d-accent); stroke-width: 0.45; opacity: 0.55; }
.insert-body {
	fill: var(--s2d-body);
	stroke: var(--s2d-body-line);
	stroke-width: 0.35;
	stroke-linejoin: round;
	pointer-events: none;
}
.pocket.depleted .insert-body { stroke-dasharray: 1.4 1; opacity: 0.4; }
.hole { fill: var(--s2d-pocket); pointer-events: none; }
.dot { pointer-events: none; }
/* A fresh dot is solid green; a used one solid grey. Either has a ring in the page's background tone, so it stands off the body in
   both themes (dark ring in the dark theme, light in the light one). The underside dot is smaller: a ring in its state colour round a
   core, on the body's own tone. */
.dot .ring { stroke: var(--theme--background); stroke-width: 0.6; }
.dot.fresh .ring { fill: var(--s2d-fresh); }
.dot.used .ring { fill: var(--s2d-used); }
.dot.under .ring { fill: var(--s2d-body); stroke-width: 0.7; }
.dot.under.fresh .ring { stroke: var(--s2d-fresh); }
.dot.under.used .ring { stroke: var(--s2d-used); }
.dot.under.fresh .core { fill: var(--s2d-fresh); }
.dot.under.used .core { fill: var(--s2d-used); }
.dot.hollow .ring { fill: none; stroke: var(--s2d-used); stroke-width: 0.4; }
.dot.hollow.fresh .ring { stroke: var(--s2d-fresh); }
.dot.next .ring { stroke-dasharray: 0.9 0.5; }
.pocket.depleted .dot { opacity: 0.55; }
.etch { fill: var(--s2d-ink); font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none; user-select: none; }
.etch.title { font-weight: 700; letter-spacing: 0.02em; }
</style>
