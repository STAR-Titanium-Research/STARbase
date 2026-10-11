<script setup lang="ts">
import { ref, useId } from 'vue';

// A titled block of a page, drawn as the force app's panel: an opaque body under a lid that holds
// the title, the count and the actions. An empty section is its lid only: the title, a zero count
// and the "nothing recorded" text on the one line, with no body under it.
const props = defineProps<{
	title: string;
	/** The element id, so the contents list of a record page (PageContents) can scroll to the section. */
	id?: string;
	count?: number | null;
	collapsible?: boolean;
	/** Start collapsed (only with `collapsible`). */
	collapsed?: boolean;
	/** True when there is nothing to show: the body is replaced by `emptyText` in the lid. */
	empty?: boolean;
	emptyText?: string;
}>();
const open = ref(!props.collapsed);
// Names the region for screen readers (it was aria-labelledby on Home's blocks before the restyle).
const titleId = useId();
</script>

<template>
	<section :id="id" class="d1-section" :class="{ empty }" :aria-labelledby="titleId">
		<header class="head" :class="{ clickable: collapsible && !empty }" @click="collapsible && !empty && (open = !open)">
			<v-icon v-if="collapsible && !empty" :name="open ? 'expand_more' : 'chevron_right'" small />
			<h2 :id="titleId">{{ title }}</h2>
			<span v-if="empty || (count !== undefined && count !== null)" class="count">{{ empty ? (count ?? 0) : count }}</span>
			<span v-if="empty" class="empty-text">{{ emptyText ?? 'Nothing recorded.' }}</span>
			<span class="spacer" />
			<slot name="actions" />
		</header>
		<div v-if="!empty && open" class="body"><slot /></div>
	</section>
</template>

<style scoped>
.d1-section {
	min-width: 0;
	background: var(--d1-surface, var(--theme--background));
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px);
	box-shadow: var(--d1-shadow, none);
	overflow: hidden;
	/* A click in the contents list scrolls here: stop under the page's sticky offset, not behind it. */
	scroll-margin-top: calc(var(--d1-sticky-top, 0px) + 8px);
}
.head {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 38px;
	padding: 5px 14px;
	background: var(--d1-tile, var(--theme--background-subdued));
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
/* An empty section is only its lid: no rule under it. */
.empty .head { border-bottom: 0; }
.clickable { cursor: pointer; user-select: none; }
h2 { margin: 0; font-size: var(--fs-md, 13px); font-weight: 650; letter-spacing: 0.01em; line-height: 1.3; }
.count {
	font-size: var(--fs-xs, 11px);
	font-weight: 700;
	font-variant-numeric: tabular-nums;
	padding: 1px 7px;
	border-radius: 99px;
	color: var(--d1-accent, var(--theme--primary));
	background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent);
}
.spacer { flex: 1; }
.body { padding: 12px 14px; }
.empty-text { min-width: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); overflow-wrap: anywhere; }
</style>
