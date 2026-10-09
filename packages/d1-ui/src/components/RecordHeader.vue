<script setup lang="ts">
// The top of a record page: what kind of record it is, its code, its status and its actions.
// Slots: `crumbs` (project / campaign breadcrumb), `status`, `meta` (owner, dates ...), `actions`.
defineProps<{ code: string; title?: string; kind: string; icon?: string }>();
</script>

<template>
	<header class="d1-record-header">
		<nav v-if="$slots.crumbs" class="d1-crumbs"><slot name="crumbs" /></nav>
		<div class="main">
			<div class="ident">
				<span class="kind"><v-icon v-if="icon" :name="icon" x-small />{{ kind }}</span>
				<h1 class="code">{{ code }}</h1>
				<slot name="status" />
				<span v-if="title" class="title">{{ title }}</span>
			</div>
			<div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
		</div>
		<div v-if="$slots.meta" class="meta"><slot name="meta" /></div>
	</header>
</template>

<style scoped>
.d1-record-header {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px 16px 14px;
	background: var(--d1-surface, var(--theme--background));
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px);
	box-shadow: var(--d1-shadow, none);
	container-type: inline-size;
}
/* The identity takes the width that is left and wraps inside it, so a long code never pushes the
   actions onto a line of their own. */
.main { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px 16px; }
.ident { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; min-width: 0; }
.kind {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: var(--fs-xs, 11px);
	font-weight: 700;
	letter-spacing: 0.01em;
	padding: 2px 9px;
	border-radius: 99px;
	color: var(--theme--primary);
	background: color-mix(in srgb, var(--theme--primary) 12%, transparent);
}
.code {
	margin: 0;
	font-size: var(--fs-2xl, 22px);
	font-weight: 700;
	line-height: 1.2;
	letter-spacing: -0.01em;
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	overflow-wrap: anywhere;
}
.title { font-size: var(--fs-lg, 15px); color: var(--d1-dim, var(--theme--foreground-subdued)); overflow-wrap: anywhere; }
.actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 2px 20px; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
/* Under this width four action buttons leave the code too little room: it broke mid-code
   ("10-AA-MF-2023-" / "3-31"), so the actions go under the identity instead. */
@container (max-width: 860px) {
	.main { grid-template-columns: minmax(0, 1fr); }
	.actions { justify-content: flex-start; }
}
</style>
