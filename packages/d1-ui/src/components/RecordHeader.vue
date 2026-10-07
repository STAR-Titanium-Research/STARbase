<script setup lang="ts">
// The top of a record page: what kind of record it is, its code, its status and its actions.
// Slots: `crumbs` (project / campaign breadcrumb), `status`, `meta` (owner, dates ...), `actions`.
defineProps<{ code: string; title?: string; kind: string; icon?: string }>();
</script>

<template>
	<header class="d1-record-header">
		<nav v-if="$slots.crumbs" class="crumbs"><slot name="crumbs" /></nav>
		<div class="main">
			<span class="kind"><v-icon v-if="icon" :name="icon" small />{{ kind }}</span>
			<h1 class="code">{{ code }}</h1>
			<span v-if="title" class="title">{{ title }}</span>
			<slot name="status" />
			<span class="spacer" />
			<div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
		</div>
		<div v-if="$slots.meta" class="meta"><slot name="meta" /></div>
	</header>
</template>

<style scoped>
.d1-record-header { display: flex; flex-direction: column; gap: 8px; padding-bottom: 18px; border-bottom: 1px solid var(--theme--border-color-subdued); }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; color: var(--theme--foreground-subdued); }
.main { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; }
.kind {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	padding: 2px 10px;
	border-radius: 99px;
	color: var(--theme--primary);
	background: var(--theme--primary-background);
}
.code {
	margin: 0;
	font-size: 26px;
	font-weight: 750;
	letter-spacing: -0.01em;
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	overflow-wrap: anywhere;
}
.title { font-size: 15px; color: var(--theme--foreground-subdued); }
.spacer { flex: 1; }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 22px; font-size: 13.5px; color: var(--theme--foreground-subdued); }
</style>
