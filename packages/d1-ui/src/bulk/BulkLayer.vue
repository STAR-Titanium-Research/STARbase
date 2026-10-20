<script setup lang="ts">
// What an index page draws for bulk actions besides the menu: the dialog, and the stack of undo toasts (bottom right, one per action
// still counting down or just finished). Both are teleported to <body>. The page makes `bulk` with reactive(useBulkActions(...)).
import '../components/tokens.css';
import type { IndexDef } from '../index/indexConfig';
import BulkDialog from './BulkDialog.vue';
import UndoToast from './UndoToast.vue';
import type { BulkState } from './useBulkActions';

defineProps<{
	bulk: BulkState;
	def: IndexDef;
	/** Called after the dialog closes: gives focus back to the menu button. */
	restoreFocus: () => void;
}>();
</script>

<template>
	<BulkDialog :bulk="bulk" :def="def" :restore-focus="restoreFocus" />
	<Teleport to="body">
		<!-- Always mounted, so the stack itself is in the page before the first toast (each toast fills its own status region a moment after it appears). -->
		<div class="d1-kit bulk-toasts">
			<UndoToast v-for="t in bulk.toasts" :key="t.actionId" :toast="t" @undo="bulk.undo(t.actionId)" @dismiss="bulk.dismiss(t.actionId)" />
		</div>
	</Teleport>
</template>

<style scoped>
/* The toast band of DESIGN.md (1000). The container lets clicks through; each card takes its own. */
.bulk-toasts {
	position: fixed; z-index: 1000; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none;
	font-family: var(--theme--fonts--sans--font-family, inherit);
}
.bulk-toasts > * { pointer-events: auto; }
</style>
