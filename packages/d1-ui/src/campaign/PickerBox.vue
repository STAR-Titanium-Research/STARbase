<script setup lang="ts">
// The search box of an "add ..." picker: a dashed box with a search field, an optional filter chip,
// a searching / nothing-found line and the results (default slot). The parent owns the search.
defineProps<{
	placeholder: string;
	filterLabel?: string;
	searching?: boolean;
	/** True when a search ran and found nothing (shows `emptyText`). */
	noResults?: boolean;
	emptyText?: string;
}>();
const search = defineModel<string>({ default: '' });
</script>

<template>
	<div class="picker">
		<div class="head">
			<v-icon name="add" x-small />
			<input v-model="search" class="search" :placeholder="placeholder" :aria-label="placeholder" />
			<span v-if="filterLabel" class="filter">{{ filterLabel }}</span>
		</div>
		<div v-if="searching" class="msg"><v-progress-circular indeterminate x-small /> searching…</div>
		<div v-else-if="noResults" class="msg">{{ emptyText ?? 'Nothing matches.' }}</div>
		<div v-else class="results"><slot /></div>
	</div>
</template>

<style scoped>
.picker { border: 1px dashed var(--theme--border-color); border-radius: 10px; padding: 8px 12px; margin-top: 10px; }
.head { display: flex; align-items: center; gap: 6px; }
.search {
	flex: 1 1 auto;
	border: 0;
	background: transparent;
	font: inherit;
	font-size: 13.5px;
	outline: none;
	color: var(--theme--foreground);
}
.filter {
	font-size: 10px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--theme--primary);
	background: var(--theme--primary-background);
	padding: 2px 8px;
	border-radius: 99px;
}
.msg { display: flex; align-items: center; gap: 6px; padding: 6px 2px; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.results { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; max-height: 260px; overflow-y: auto; }
.results :deep(.pick) {
	display: flex;
	align-items: center;
	gap: 8px;
	text-align: left;
	border: 1px solid var(--theme--border-color-subdued);
	background: var(--theme--background);
	color: var(--theme--foreground);
	border-radius: 8px;
	padding: 5px 10px;
	cursor: pointer;
	font: inherit;
}
.results :deep(.pick:hover:not(:disabled)) { border-color: var(--theme--primary); background: var(--theme--primary-background); }
.results :deep(.pick:disabled) { opacity: 0.6; cursor: default; }
.results :deep(.pick .sub) { margin-left: auto; margin-right: 6px; font-size: 11.5px; color: var(--theme--foreground-subdued); }
.results :deep(.pick .code) { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 650; }
</style>
