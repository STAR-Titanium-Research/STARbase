<script setup lang="ts">
// A record as a card: its code, a tag beside it, its name, a line of meta, then anything else
// (counts, a progress bar, a chart). The whole card is the link. Inside a panel it is a tile one
// step off the surface; `raised` is for a card that sits on the page ground on its own.
defineProps<{ to?: string | null; code: string; name?: string | null; raised?: boolean }>();
</script>

<template>
	<component :is="to ? 'router-link' : 'div'" :to="to || undefined" class="d1-card" :class="{ link: !!to, raised }">
		<span class="top">
			<span class="code">{{ code }}</span>
			<slot name="tag" />
		</span>
		<span v-if="name" class="name">{{ name }}</span>
		<span v-if="$slots.meta" class="meta"><slot name="meta" /></span>
		<slot />
	</component>
</template>

<style scoped>
.d1-card {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
	padding: 10px 12px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 10px;
	background: var(--d1-tile, var(--theme--background-subdued));
	color: var(--theme--foreground);
	text-decoration: none;
}
.d1-card.raised {
	padding: 12px 14px;
	border-radius: var(--d1-radius, 12px);
	background: var(--d1-surface, var(--theme--background));
	box-shadow: var(--d1-shadow, none);
}
.link { transition: border-color 0.12s ease; }
.link:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
.code {
	margin-right: auto;
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	font-size: var(--fs-md, 13px);
	font-weight: 700;
	overflow-wrap: anywhere;
}
.raised .code { font-size: var(--fs-lg, 15px); }
.name { font-size: var(--fs-md, 13px); font-weight: 600; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 0 14px; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
/* A plain tag beside the code (a type, a role). A status uses StatusBadge instead. */
.d1-card :deep(.d1-tag) {
	font-size: var(--fs-xs, 11px);
	font-weight: 700;
	padding: 1px 8px;
	border-radius: 99px;
	white-space: nowrap;
	color: var(--d1-accent, var(--theme--primary));
	background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent);
}
.d1-card :deep(.d1-counts) { display: flex; flex-wrap: wrap; gap: 0 14px; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-card :deep(.d1-counts b) { font-size: var(--fs-md, 13px); font-variant-numeric: tabular-nums; color: var(--theme--foreground); }
</style>
