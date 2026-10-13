<script setup lang="ts">
// The camera scan dialog (spec decision 12): shows the rear camera, reads a label's QR code, and
// opens the sample it names. When it cannot (deleted, no access, server unreachable) or the code is
// not a D1 label, it shows what was read and why, and offers to scan again. The camera is released
// when the dialog closes or the page goes away.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { EXPLORER_HOST, ScanResultCard, resolveLabel } from '@d1/ui';
import type { ScanOutcome } from '@d1/ui';
import { useQrCamera } from './useQrCamera';

const emit = defineEmits<{ (e: 'close'): void }>();

const host = inject(EXPLORER_HOST);
if (!host) throw new Error('ScanDialog needs an ExplorerHost: render it inside ExplorerView');

const outcome = ref<Exclude<ScanOutcome, { kind: 'open' }> | null>(null);
const resolving = ref(false);
let closed = false;

async function onText(text: string): Promise<void> {
	resolving.value = true;
	const out = await resolveLabel(host!.api, text);
	resolving.value = false;
	if (closed) return;
	if (out.kind === 'open') {
		host!.navigate(out.to);
		close();
	} else {
		outcome.value = out;
	}
}

const { video, state, error, start } = useQrCamera((t) => void onText(t));

function openTo(to: string): void {
	host!.navigate(to);
	close();
}

function close(): void {
	emit('close');
}

function again(): void {
	outcome.value = null;
	void start();
}

const dialog = ref<HTMLElement | null>(null);
const opener = document.activeElement as HTMLElement | null;
onMounted(async () => {
	await nextTick();
	dialog.value?.querySelector<HTMLElement>('button')?.focus();
	void start();
});
onBeforeUnmount(() => {
	closed = true;
	if (opener?.isConnected) opener.focus();
});

// Escape closes; Tab stays among the dialog's own buttons.
function onKeydown(e: KeyboardEvent): void {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		close();
	} else if (e.key === 'Tab') {
		const items = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
}

const status = computed(() => {
	if (resolving.value) return 'Opening the sample…';
	if (state.value === 'starting') return 'Starting the camera…';
	if (state.value === 'scanning') return 'Point the camera at the QR code on a label.';
	return '';
});
const showError = computed(() => state.value === 'error' && !outcome.value);
</script>

<template>
	<Teleport to="body">
		<div class="d1-kit d1-scan-backdrop" @mousedown.self="close">
			<div ref="dialog" class="d1-scan" role="dialog" aria-modal="true" aria-label="Scan a label" @keydown="onKeydown">
				<header>
					<h2>Scan a label</h2>
					<button type="button" class="btn" @click="close">Close</button>
				</header>

				<div v-show="!outcome && !showError" class="view">
					<video ref="video" playsinline muted autoplay aria-label="Camera view" />
					<div class="aim" aria-hidden="true" />
				</div>

				<p v-if="status" class="note" role="status" aria-live="polite">{{ status }}</p>
				<p v-if="showError" class="note err" role="alert">{{ error }}</p>
				<ScanResultCard v-if="outcome" :outcome="outcome" @open="openTo" />

				<footer v-if="outcome || showError">
					<button type="button" class="btn primary" :disabled="resolving" @click="again">{{ showError ? 'Try again' : 'Scan again' }}</button>
				</footer>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.d1-scan-backdrop {
	position: fixed; inset: 0; z-index: 9999;
	display: flex; align-items: flex-start; justify-content: center;
	padding: 6vh 12px 12px; overflow-y: auto;
	background: rgba(0, 0, 0, 0.5);
	font-family: var(--theme--fonts--sans--font-family, inherit);
	color: var(--theme--foreground);
}
.d1-scan {
	width: min(480px, 100%); display: flex; flex-direction: column; gap: 8px; padding-bottom: 12px;
	border: 1px solid var(--d1-line); border-radius: var(--d1-radius);
	background: var(--d1-surface); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3); overflow: hidden;
}
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 0 16px; }
h2 { margin: 0; font-size: var(--fs-lg, 15px); font-weight: 700; }
.view { position: relative; margin: 0 12px; border-radius: 10px; overflow: hidden; background: #000; aspect-ratio: 4 / 3; }
video { width: 100%; height: 100%; object-fit: cover; display: block; }
.aim {
	position: absolute; inset: 18%; border: 2px solid rgba(255, 255, 255, 0.85); border-radius: 12px;
	box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.25); pointer-events: none;
}
.note { margin: 0 16px; font-size: var(--fs-md, 13px); color: var(--d1-dim); }
.note.err { color: var(--theme--danger, var(--theme--foreground)); font-weight: 600; }
footer { display: flex; justify-content: flex-end; padding: 0 12px; }
.btn {
	height: 34px; padding: 0 14px; border: 1px solid var(--d1-line); border-radius: 8px; cursor: pointer;
	background: var(--d1-tile); color: inherit; font: inherit; font-size: var(--fs-md, 13px); font-weight: 600;
}
.btn.primary { background: var(--d1-accent, var(--theme--primary)); border-color: transparent; color: var(--theme--primary-foreground, #fff); }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
