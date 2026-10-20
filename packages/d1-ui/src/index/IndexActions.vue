<script setup lang="ts">
// The page's own buttons, on the breadcrumb line of an index page (IndexPage): the select action ("Print labels
// for selected", disabled until rows are ticked, then "(2)"), Open in Data Studio and "+ New". In picker mode the
// buttons that navigate away give way to the confirm button. They are the page's actions, not the toolbar's
// (search and filters) nor the View rail's (how rows look). It draws what IndexPage hands it and reports clicks.
import { useExplorerHost } from '../host';
import type { IndexDef } from './indexConfig';

defineProps<{
	def: IndexDef;
	pick?: boolean;
	/** Picker mode: the confirm button's text and how many rows it would add. */
	pickText: string;
	pickCount: number;
	/** The def's select action and how many rows are ticked for it. */
	pickedCount: number;
	dsLink: { to: string; note?: string | null };
}>();
const emit = defineEmits<{ confirm: []; run: [] }>();

const host = useExplorerHost();
</script>

<template>
	<div class="actions">
		<button v-if="pick" type="button" class="btn pri" :disabled="!pickCount" @click="emit('confirm')">{{ pickText }}</button>
		<button v-else-if="def.selectAction" type="button" class="btn" :disabled="!pickedCount" @click="emit('run')">
			{{ def.selectAction.label }}{{ pickedCount ? ` (${pickedCount})` : '' }}
		</button>
		<template v-if="!pick">
			<button type="button" class="btn" :title="dsLink.note ?? undefined" @click="host.openDataStudio(dsLink.to)">Open in Data Studio</button>
			<button v-if="!host.canViewAllAccess?.value" type="button" class="btn pri" @click="host.openDataStudio(`/content/${def.collection}/+`)">+ New</button>
		</template>
	</div>
</template>

<style scoped>
.actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: auto; }
.btn {
	display: inline-flex; align-items: center; height: 30px; padding: 0 12px;
	border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-tile); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; white-space: nowrap; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn.pri { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.btn:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
</style>
