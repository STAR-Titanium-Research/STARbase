<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Editor } from './editor';

// The edit dialog (spec §3.4). Esc and the backdrop do NOT close it: the edits are in the frame, which
// STARbase cannot see, so closing is the close button, which asks first once the form is showing.
const props = defineProps<{ editor: Editor }>();
const s = props.editor.state;
const frameEl = ref<HTMLIFrameElement | null>(null);
const confirmClose = ref(false);
const onMessage = (e: MessageEvent) => props.editor.onMessage(e);

onMounted(() => {
	window.addEventListener('message', onMessage);
	props.editor.attachFrame(() => frameEl.value?.contentWindow ?? null);
});
onBeforeUnmount(() => window.removeEventListener('message', onMessage));
watch(() => s.phase, () => (confirmClose.value = false));

function askClose() {
	if (s.phase === 'ready') confirmClose.value = true;
	else props.editor.close();
}
</script>

<template>
	<Teleport to="body">
		<div v-if="s.phase !== 'closed'" class="sb-editor-backdrop">
			<div class="sb-editor" role="dialog" aria-modal="true" aria-label="Edit record">
				<header class="sb-editor-head">
					<span class="sb-editor-title">Edit</span>
					<template v-if="confirmClose">
						<span class="sb-editor-ask">Close without saving? Changes in the form are lost.</span>
						<button type="button" class="sb-editor-btn danger" @click="editor.close()">Close</button>
						<button type="button" class="sb-editor-btn" @click="confirmClose = false">Keep editing</button>
					</template>
					<button v-else type="button" class="sb-editor-x" aria-label="Close the form" @click="askClose"><v-icon name="close" /></button>
				</header>
				<div v-if="s.phase === 'refused'" class="sb-editor-note" role="alert">
					<p v-if="s.blocked">The browser blocked the new tab. Allow pop-ups for STARbase and try again.</p>
					<p v-else>The form didn't open here. You may need to sign in again below, or this browser does not allow the form inside STARbase.</p>
					<v-button small @click="editor.openInTab()">Open in a new tab</v-button>
				</div>
				<div v-else-if="s.phase === 'tab'" class="sb-editor-note" role="status">
					<p>The form is open in another tab. Save or cancel there, then come back: this page refreshes when you do.</p>
					<v-button small secondary @click="editor.done()">Done</v-button>
				</div>
				<iframe
					v-if="s.phase !== 'tab'"
					ref="frameEl"
					class="sb-editor-frame"
					:class="{ waiting: s.phase === 'loading' }"
					:src="s.url"
					title="Directus form"
				/>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.sb-editor-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, 0.45); }
.sb-editor {
	display: flex; flex-direction: column; width: min(1100px, 100%); height: min(860px, calc(100dvh - 32px));
	border-radius: 12px; overflow: hidden; background: var(--theme--background); box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35);
}
.sb-editor-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--theme--border-color-subdued); }
.sb-editor-title { flex: 1 1 auto; font-weight: 700; }
.sb-editor-ask { color: var(--theme--foreground-subdued); }
.sb-editor-x, .sb-editor-btn { border: 0; background: none; padding: 6px 8px; font: inherit; color: var(--theme--foreground); cursor: pointer; border-radius: 6px; }
.sb-editor-btn.danger { color: var(--theme--danger); font-weight: 700; }
.sb-editor-note { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 16px; background: var(--theme--background-normal); }
.sb-editor-note p { margin: 0; flex: 1 1 240px; }
.sb-editor-frame { flex: 1 1 auto; width: 100%; border: 0; background: var(--theme--background); }
.sb-editor-frame.waiting { opacity: 0.4; }
@media (max-width: 767px) {
	.sb-editor-backdrop { padding: 0; }
	.sb-editor { width: 100%; height: 100dvh; border-radius: 0; }
}
</style>
