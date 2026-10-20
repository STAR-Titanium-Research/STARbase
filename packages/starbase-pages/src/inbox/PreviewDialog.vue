<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useExplorerHost } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { extractedText, folderText, nameOf } from './inboxModel';
import { usePicture } from './usePicture';

// The full view of a found file's picture (spec 2026-10-15-found-files-inbox-design.md section 14): a modal with the reduced-size preview, a spinner
// while it loads (the thumbnail the row already has shows, blurred and scaled up, meanwhile), an error with Retry, and the file's name, folder and
// what the crawler read. Esc, a click outside and the Close button close it; focus starts on Close and stays inside (Tab wraps). The row that opened it
// puts focus back on its thumbnail button. It is its own modal rather than v-dialog so it can be wide, and so it behaves the same in both hosts. It
// wears d1-kit: teleported to <body> it is outside the page frame that sets the --d1-* tokens.
const props = defineProps<{
	file: FoundFile;
	/** The row's thumbnail as an object URL, when it has loaded: shown blurred until the preview is in. */
	thumbUrl: string | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const titleId = `inbox-preview-title-${Math.random().toString(36).slice(2, 10)}`;

const host = useExplorerHost();
const { state, url, retry } = usePicture(host.api, () => props.file.candidate_id, 'preview', () => true, { priority: true });

const name = computed(() => nameOf(props.file.rel_path));
const folder = computed(() => folderText(props.file.rel_path));
const read = computed(() => extractedText(props.file.extracted));

const box = ref<HTMLElement | null>(null);

// One live region that is always in the page (a region inserted together with its text is often not announced): its text is filled in after mount
// and swapped as the picture loads. The visible spinner and text are for the eyes only. A failure is announced by the error's own role="alert".
const announceReady = ref(false);
const statusText = computed(() => {
	if (!announceReady.value || state.value === 'failed') return '';
	return state.value === 'ready' ? 'Preview ready.' : 'Loading preview…';
});

/** Retry takes the focus on Retry with it when it disappears: put it back on Close. */
async function retryPreview(): Promise<void> {
	retry();
	await nextTick();
	box.value?.querySelector<HTMLElement>('[data-test="preview-close"]')?.focus();
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusables = (): HTMLElement[] => [...(box.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];

// Esc closes (and nothing behind it hears the key); Tab and Shift+Tab wrap inside the dialog.
function onKeydown(e: KeyboardEvent): void {
	if (e.key === 'Escape') {
		e.stopPropagation();
		e.preventDefault();
		emit('close');
		return;
	}
	if (e.key !== 'Tab') return;
	const items = focusables();
	if (!items.length) {
		e.preventDefault();
		box.value?.focus();
		return;
	}
	const first = items[0];
	const last = items[items.length - 1];
	const active = document.activeElement;
	if (!box.value?.contains(active)) {
		e.preventDefault();
		first.focus();
	} else if (e.shiftKey && (active === first || active === box.value)) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	}
}

onMounted(async () => {
	document.addEventListener('keydown', onKeydown, true);
	await nextTick();
	const target = box.value?.querySelector<HTMLElement>('[data-test="preview-close"]') ?? box.value;
	target?.focus();
	announceReady.value = true;
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
	<Teleport to="body">
		<div class="d1-kit pv-backdrop" data-test="preview-backdrop" @mousedown.self.prevent="emit('close')">
			<div ref="box" class="pv" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" data-test="preview-dialog" :data-state="state">
				<h2 :id="titleId" class="pv-title">{{ name }}</h2>
				<p class="pv-sr" role="status" data-test="preview-status">{{ statusText }}</p>

				<div class="pv-stage" data-test="preview-stage">
					<img v-if="state === 'ready' && url" :src="url" :alt="`Preview of ${name}`" class="pv-img" data-test="preview-image" />
					<template v-else>
						<img v-if="thumbUrl" :src="thumbUrl" alt="" aria-hidden="true" class="pv-ghost" data-test="preview-thumb" />
						<div v-else class="pv-blank" aria-hidden="true" />
						<div v-if="state !== 'failed'" class="pv-loading" aria-hidden="true" data-test="preview-loading">
							<span class="pv-spinner" />
							<span>Loading preview…</span>
						</div>
					</template>
				</div>

				<div v-if="state === 'failed'" class="pv-error" role="alert" data-test="preview-error">
					<span>The preview could not be loaded.</span>
					<v-button small secondary data-test="preview-retry" @click="retryPreview">Retry</v-button>
				</div>

				<dl class="pv-facts">
					<div><dt>Folder</dt><dd :title="file.rel_path">{{ folder }}</dd></div>
					<div v-if="read"><dt>Read from the image</dt><dd>{{ read }}</dd></div>
				</dl>

				<p class="pv-note" data-test="preview-note">Reduced-size preview. The original stays on the share.</p>

				<div class="pv-actions">
					<v-button secondary data-test="preview-close" @click="emit('close')">Close</v-button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.pv-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, 0.6); overscroll-behavior: contain; }
.pv {
	box-sizing: border-box; width: min(960px, 100%); max-height: calc(100dvh - 32px); overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px 20px 16px;
	border: 1px solid var(--d1-line); border-radius: 12px; background: var(--d1-surface, var(--theme--background, #fff)); color: var(--theme--foreground);
	box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
}
.pv:focus { outline: none; }
.pv-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.pv-title { margin: 0; font-size: var(--fs-lg, 16px); font-weight: 650; overflow-wrap: anywhere; }
.pv-stage {
	position: relative; display: grid; place-items: center; min-height: 220px; border-radius: 8px; overflow: hidden;
	background: var(--d1-tile, var(--theme--background-subdued));
}
.pv-img { display: block; max-width: 100%; max-height: min(70dvh, 1200px); object-fit: contain; }
/* The thumbnail, enlarged and out of focus: it shows where the picture will be and how it is framed while the real one loads. */
.pv-ghost { display: block; width: min(100%, 560px); max-height: 60dvh; object-fit: contain; filter: blur(10px); transform: scale(1.04); }
.pv-blank { width: 100%; height: 220px; }
.pv-loading {
	position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: var(--fs-md, 13px); font-weight: 600;
	color: var(--theme--foreground); background: color-mix(in srgb, var(--theme--background, #fff) 35%, transparent);
}
.pv-spinner {
	width: 22px; height: 22px; border-radius: 50%; border: 3px solid color-mix(in srgb, var(--d1-dim) 35%, transparent); border-top-color: var(--d1-accent, var(--theme--primary));
	animation: pv-spin 0.9s linear infinite;
}
@keyframes pv-spin { to { transform: rotate(360deg); } }
.pv-error {
	display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 8px 14px; border-radius: 10px; font-size: var(--fs-md, 13px);
	border: 1px solid color-mix(in srgb, var(--d1-bad) 40%, transparent); background: color-mix(in srgb, var(--d1-bad) 12%, transparent);
}
.pv-facts { margin: 0; display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm, 12px); }
.pv-facts div { display: flex; flex-wrap: wrap; gap: 0 8px; }
.pv-facts dt { color: var(--d1-dim); }
.pv-facts dt::after { content: ':'; }
.pv-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.pv-note { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.pv-actions { display: flex; justify-content: flex-end; }
/* No spinning under reduced motion: the "Loading preview…" text next to it still says what is going on. */
@media (prefers-reduced-motion: reduce) {
	.pv-spinner { animation: none; }
}
</style>
