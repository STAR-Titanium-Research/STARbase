<script setup lang="ts">
import type { StoredQuestion } from './history';

defineProps<{ title: string; items: StoredQuestion[]; disabled?: boolean; testId: string }>();
defineEmits<{ (e: 'run', question: string): void; (e: 'remove', question: string): void }>();
</script>

<template>
	<div v-if="items.length" class="qlist" :data-test="testId">
		<h3 class="title">{{ title }}</h3>
		<ul>
			<li v-for="item in items" :key="item.question" class="row">
				<span class="text" :title="item.question">{{ item.question }}</span>
				<button
					type="button"
					class="run"
					data-test="ask-run-again"
					:disabled="disabled"
					@click="$emit('run', item.question)"
				>
					Run again
				</button>
				<button
					type="button"
					class="remove"
					data-test="ask-remove"
					:aria-label="`Remove: ${item.question}`"
					title="Remove"
					@click="$emit('remove', item.question)"
				>
					×
				</button>
			</li>
		</ul>
	</div>
</template>

<style scoped>
.qlist {
	margin-top: 24px;
}
.title {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--theme--foreground-subdued, #6c7789);
	margin: 0 0 6px;
}
ul {
	list-style: none;
	margin: 0;
	padding: 0;
}
.row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 0;
	border-bottom: 1px solid var(--theme--border-color-subdued, #e0e2e7);
}
.text {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 14px;
	color: var(--theme--foreground, #2f3a4c);
}
button {
	border: 1px solid var(--theme--border-color, #d3dae4);
	border-radius: 6px;
	background: var(--theme--background, #fff);
	color: var(--theme--foreground, #2f3a4c);
	font-size: 12px;
	padding: 3px 10px;
	cursor: pointer;
}
button:hover:not(:disabled) {
	border-color: var(--theme--primary, #6644ff);
	color: var(--theme--primary, #6644ff);
}
button:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.remove {
	padding: 3px 8px;
	font-size: 14px;
	line-height: 1;
}
</style>
