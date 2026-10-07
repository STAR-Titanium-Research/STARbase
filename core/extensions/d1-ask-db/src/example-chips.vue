<script setup lang="ts">
import { EXAMPLE_QUESTIONS } from './examples';

defineProps<{ disabled?: boolean }>();
defineEmits<{ (e: 'pick', question: string): void }>();
</script>

<template>
	<div class="chips" data-test="ask-examples">
		<div v-for="group in EXAMPLE_QUESTIONS" :key="group.topic" class="group">
			<span class="topic">{{ group.topic }}</span>
			<button
				v-for="q in group.questions"
				:key="q"
				type="button"
				class="chip"
				data-test="ask-example"
				:disabled="disabled"
				@click="$emit('pick', q)"
			>
				{{ q }}
			</button>
		</div>
	</div>
</template>

<style scoped>
.chips {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin-top: 12px;
}
.group {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}
.topic {
	min-width: 70px;
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--theme--foreground-subdued, #6c7789);
}
.chip {
	padding: 6px 14px;
	border: 1px solid var(--theme--border-color, #d3dae4);
	border-radius: 999px;
	background: var(--theme--background, #fff);
	color: var(--theme--foreground, #2f3a4c);
	font-size: 13px;
	text-align: left;
	cursor: pointer;
}
.chip:hover:not(:disabled) {
	border-color: var(--theme--primary, #6644ff);
	color: var(--theme--primary, #6644ff);
}
.chip:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
</style>
