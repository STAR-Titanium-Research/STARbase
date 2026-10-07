<script setup lang="ts">
// Renders the shared DiagnosticsWorkbench. Its ForceHost is installed once at bootstrap (main.ts).
import { DiagnosticsWorkbench, type Recipe } from '@d1/force-plotting';
import { appUrl } from '../appUrl';

const props = withDefaults(defineProps<{
	diagPath: string;
	analysisId: string;
	diagMetrics: Record<string, unknown> | null;
	initialRecipe: Recipe | null;
	bakedRecipe: Recipe | null;
	baking?: boolean;
	bakeMessage?: string | null;
	opTag?: string;
}>(), { baking: false, bakeMessage: null });
const emit = defineEmits<{ (e: 'bake', recipe: Recipe): void }>();

// Pop a Spatial view out to its own window (second monitor), like the Record tab's live panels.
function onPopout(p: { type: string; channel?: string }) {
	const q = new URLSearchParams();
	if (p.channel) q.set('channel', p.channel);
	window.open(
		appUrl(`/diag-panel/${props.analysisId}?${q}`),
		`diag-${p.type}-${props.analysisId}`,
		'noopener,width=1300,height=950',
	);
}
</script>

<template>
	<DiagnosticsWorkbench
		:diag-path="props.diagPath"
		:analysis-id="props.analysisId"
		:op-tag="props.opTag"
		:diag-metrics="props.diagMetrics"
		:initial-recipe="props.initialRecipe"
		:baked-recipe="props.bakedRecipe"
		:baking="props.baking"
		:bake-message="props.bakeMessage"
		@bake="(r: Recipe) => emit('bake', r)"
		@popout="onPopout"
	/>
</template>
