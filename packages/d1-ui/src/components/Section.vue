<script setup lang="ts">
import { ref } from 'vue';

// A titled block of a page. An empty section collapses to its title and one line of text.
const props = defineProps<{
	title: string;
	count?: number | null;
	collapsible?: boolean;
	/** Start collapsed (only with `collapsible`). */
	collapsed?: boolean;
	/** True when there is nothing to show: the body is replaced by `emptyText`. */
	empty?: boolean;
	emptyText?: string;
}>();
const open = ref(!props.collapsed);
</script>

<template>
	<section class="d1-section" :class="{ empty }">
		<header class="head" :class="{ clickable: collapsible }" @click="collapsible && (open = !open)">
			<v-icon v-if="collapsible" :name="open ? 'expand_more' : 'chevron_right'" small />
			<h2>{{ title }}</h2>
			<span v-if="count !== undefined && count !== null" class="count">{{ count }}</span>
			<span class="spacer" />
			<slot name="actions" />
		</header>
		<p v-if="empty" class="empty-text">{{ emptyText ?? 'Nothing recorded.' }}</p>
		<div v-else-if="open" class="body"><slot /></div>
	</section>
</template>

<style scoped>
.d1-section { margin-top: 28px; }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.clickable { cursor: pointer; user-select: none; }
h2 { margin: 0; font-size: 16px; font-weight: 700; }
.count {
	font-size: 11.5px;
	font-weight: 700;
	padding: 0 8px;
	border-radius: 99px;
	background: var(--theme--background-normal);
	color: var(--theme--foreground-subdued);
}
.spacer { flex: 1; }
.empty-text { margin: 0; font-size: 13px; font-style: italic; color: var(--theme--foreground-subdued); }
.empty .head { margin-bottom: 4px; }
</style>
