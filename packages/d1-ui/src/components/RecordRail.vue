<script setup lang="ts">
import FactList from './FactList.vue';
import PageContents from './PageContents.vue';
import type { Fact } from '../record/facts';
import type { ContentsEntry } from '../record/contents';

// The rail of a record page, in RecordLayout's `rail` slot: one panel, its blocks in this order:
//   identity (kind, status, code, title), actions, `extra` (the sample drawing), key facts,
//   `after-facts` (progress bars), "On this page".
// Icons and buttons come in through slots (`kind-icon`, `actions`), so the host supplies its own and
// nothing here depends on the Data Studio. `status` is plain text unless the `status` slot draws a badge.
// `plain`: the code describes the record instead of being its code (an operation without a pass
// code), so it is not set in monospace as though it could be typed or scanned.
defineProps<{
	kind: string;
	status?: string;
	code: string;
	plain?: boolean;
	title?: string;
	facts: Fact[];
	contents?: ContentsEntry[];
}>();
</script>

<template>
	<div class="d1-record-rail">
		<div class="ident">
			<div class="line">
				<span class="kind"><slot name="kind-icon" />{{ kind }}</span>
				<slot name="status"><span v-if="status" class="status">{{ status }}</span></slot>
			</div>
			<h1 class="code" :class="{ plain }">{{ code }}</h1>
			<p v-if="title" class="title">{{ title }}</p>
		</div>
		<div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
		<div v-if="$slots.extra" class="extra"><slot name="extra" /></div>
		<FactList v-if="facts.length" :facts="facts" :columns="1" />
		<div v-if="$slots['after-facts']" class="after"><slot name="after-facts" /></div>
		<PageContents v-if="contents?.length" :entries="contents" />
	</div>
</template>

<style scoped>
.d1-record-rail {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 14px 16px;
	background: var(--d1-surface, var(--theme--background));
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px);
	box-shadow: var(--d1-shadow, none);
}
.ident { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
.kind {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: var(--fs-xs, 11px);
	font-weight: 700;
	letter-spacing: 0.01em;
	padding: 2px 9px;
	border-radius: 99px;
	color: var(--d1-accent, var(--theme--primary));
	background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent);
}
.status { font-size: var(--fs-sm, 12px); font-weight: 650; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.code {
	margin: 0;
	font-size: var(--fs-xl, 18px);
	font-weight: 700;
	line-height: 1.25;
	letter-spacing: -0.01em;
	font-family: var(--theme--fonts--monospace--font-family, monospace);
	overflow-wrap: anywhere;
}
.code.plain { font-family: inherit; letter-spacing: normal; }
.title { margin: 0; font-size: var(--fs-md, 13px); color: var(--d1-dim, var(--theme--foreground-subdued)); overflow-wrap: anywhere; }
/* Actions wrap to a second row; none is hidden in a menu. */
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.extra, .after { min-width: 0; }
</style>
