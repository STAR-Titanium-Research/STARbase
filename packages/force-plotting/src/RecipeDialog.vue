<script setup lang="ts">
// In-app replacement for window.prompt / window.confirm in the recipe library. One modal, three
// modes: 'save' and 'rename' (name + notes fields) and 'delete' (confirm). Keyboard handling is
// useModalFocus, as in PlotHelp.vue. The
// parent owns the async work and passes `busy` / `error` back so a failed save (name taken)
// stays open with the message instead of vanishing.
import { ref } from 'vue';
import { useModalFocus } from './modalFocus';

const props = defineProps<{
	mode: 'save' | 'rename' | 'delete';
	title: string;
	confirmLabel: string;
	name?: string;
	notes?: string;
	busy?: boolean;
	error?: string | null;
}>();
const emit = defineEmits<{
	(e: 'close'): void;
	(e: 'confirm', v: { name: string; notes: string }): void;
}>();

const rootEl = ref<HTMLElement | null>(null);
const nameEl = ref<HTMLInputElement | null>(null);
const confirmEl = ref<HTMLButtonElement | null>(null);
const name = ref(props.name ?? '');
const notes = ref(props.notes ?? '');

const needsFields = props.mode !== 'delete';

function submit() {
	if (props.busy) return;
	if (needsFields && !name.value.trim()) { nameEl.value?.focus(); return; }
	emit('confirm', { name: name.value.trim(), notes: notes.value.trim() });
}
useModalFocus(rootEl, {
	onEscape: () => { if (!props.busy) emit('close'); },
	initialFocus: () => {
		if (needsFields) { nameEl.value?.focus(); nameEl.value?.select(); }
		else confirmEl.value?.focus();
	},
});
</script>

<template>
	<Teleport to="body">
		<div class="rd-scrim" @pointerdown.self="!busy && emit('close')">
			<form ref="rootEl" class="rd-card" role="dialog" aria-modal="true" aria-labelledby="rd-title" @submit.prevent="submit">
				<div class="rd-head"><strong id="rd-title">{{ title }}</strong></div>
				<div class="rd-body">
					<template v-if="needsFields">
						<label class="rd-field">
							<span>Name</span>
							<input ref="nameEl" v-model="name" type="text" maxlength="120" :disabled="busy" required>
						</label>
						<label class="rd-field">
							<span>Notes (optional)</span>
							<textarea v-model="notes" rows="3" maxlength="500" :disabled="busy" />
						</label>
					</template>
					<slot v-else />
					<p v-if="error" class="rd-err" role="alert">{{ error }}</p>
				</div>
				<div class="rd-foot">
					<button type="button" :disabled="busy" @click="emit('close')">Cancel</button>
					<button ref="confirmEl" type="submit" :class="{ danger: mode === 'delete' }" :disabled="busy">
						{{ busy ? 'Working…' : confirmLabel }}
					</button>
				</div>
			</form>
		</div>
	</Teleport>
</template>

<style scoped>
.rd-scrim {
	position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center;
	padding: 16px; background: rgba(2, 6, 23, 0.5);
}
.rd-card {
	width: min(420px, 100%); display: flex; flex-direction: column;
	background: var(--bg-1, var(--theme--background, #0f172a)); color: var(--text, var(--theme--foreground, #e5e7eb));
	border: 1px solid var(--border, var(--theme--border-color-subdued, rgba(255,255,255,0.16))); border-radius: 10px;
	box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5); font-size: var(--fs-sm, 12px); line-height: 1.45;
}
.rd-head { padding: 10px 14px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.16)); color: var(--accent, #7dd3fc); font-size: var(--fs-md, 13px); }
.rd-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.rd-field { display: flex; flex-direction: column; gap: 3px; color: var(--text-dim, #94a3b8); }
.rd-field input, .rd-field textarea {
	font: inherit; padding: 5px 7px; color: var(--text, #e5e7eb); background: var(--bg-2, #111a33);
	border: 1px solid var(--border, rgba(255,255,255,0.14)); border-radius: 5px; resize: vertical;
}
.rd-err { margin: 0; color: var(--danger, #fca5a5); }
.rd-foot { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 14px; border-top: 1px solid var(--border, rgba(255,255,255,0.16)); }
.rd-foot button {
	font: inherit; padding: 4px 12px; border-radius: 5px; cursor: pointer; color: var(--text, #e5e7eb);
	background: var(--bg-2, #111a33); border: 1px solid var(--border, rgba(255,255,255,0.14));
}
.rd-foot button:disabled { opacity: 0.5; cursor: not-allowed; }
.rd-foot button.danger { color: var(--danger, #fca5a5); }
.rd-foot button:focus-visible, .rd-field input:focus-visible, .rd-field textarea:focus-visible {
	outline: 2px solid color-mix(in srgb, var(--accent, #38bdf8) 50%, transparent);
}
</style>
