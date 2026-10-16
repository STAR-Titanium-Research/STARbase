<script setup lang="ts">
// The 2D view of the stage, used when WebGL is missing, the stage is narrow, or the viewer asks for it. Same selection, same
// contract as the 3D view: it only emits `select`. At the box it draws the tray as a plan (TrayPlan2D); at an insert or an
// edge, one large insert with its edge letters (InsertView2D).
import { computed } from 'vue';
import type { ToolingFocus, ToolingInsert, ToolingModel } from '@d1/ui';
import './stage2d.css';
import InsertView2D from './InsertView2D.vue';
import TrayPlan2D from './TrayPlan2D.vue';

const props = defineProps<{
	model: ToolingModel;
	focus: ToolingFocus;
	nextFresh: { insertId: string; edgeId: string } | null;
}>();
const emit = defineEmits<{ select: [focus: ToolingFocus] }>();

const insert = computed<ToolingInsert | null>(() =>
	props.focus.kind === 'box' ? null : props.model.inserts.find((i) => i.id === (props.focus as { insertId: string }).insertId) ?? null);
</script>

<template>
	<div class="d1-s2d stage2d">
		<TrayPlan2D v-if="!insert" :model="model" :next-fresh="nextFresh" @select="emit('select', $event)" />
		<InsertView2D v-else :model="model" :insert="insert" :focus="focus" :next-fresh="nextFresh" @select="emit('select', $event)" />
	</div>
</template>

<style scoped>
.stage2d {
	display: flex;
	flex-direction: column;
	width: 100%;
	height: 100%;
	min-height: 0;
	padding: 10px 12px;
}
</style>
