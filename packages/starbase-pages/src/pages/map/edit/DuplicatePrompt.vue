<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

// "Duplicate ×N" (spec E10): a small prompt for how many copies. Enter makes them, Esc leaves it. Between 1 and 99, as the reducer allows.
defineProps<{ /** What is being copied, for the title. */ what: string }>();
const emit = defineEmits<{ confirm: [n: number]; close: [] }>();

const text = ref('2');
const input = ref<HTMLInputElement | null>(null);
const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
const parsed = () => {
	const n = Number(text.value);
	return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
};
function ok() {
	const n = parsed();
	if (n !== null) emit('confirm', n);
}
function onKey(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		emit('close');
	} else if (e.key === 'Enter') {
		e.preventDefault();
		ok();
	}
}
onMounted(async () => {
	await nextTick();
	input.value?.focus();
	input.value?.select();
});
onBeforeUnmount(() => {
	if (opener?.isConnected) opener.focus();
});
</script>

<template>
	<div class="pm-dup-back" @pointerdown.self="emit('close')">
		<div class="d1-kit d1-process-map pm-dup" role="dialog" aria-modal="true" :aria-label="`Duplicate ${what}`" @keydown="onKey">
			<label class="ttl" :for="'pm-dup-n'">Duplicate {{ what }} how many times?</label>
			<div class="row">
				<span class="x" aria-hidden="true">×</span>
				<input id="pm-dup-n" ref="input" v-model="text" type="number" min="1" max="99" step="1" inputmode="numeric" :aria-invalid="parsed() === null" />
			</div>
			<p v-if="parsed() === null" class="bad" role="alert">A whole number from 1 to 99.</p>
			<div class="btns">
				<v-button small secondary @click="emit('close')">Cancel</v-button>
				<v-button small :disabled="parsed() === null" @click="ok">Duplicate</v-button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.pm-dup-back { position: fixed; inset: 0; z-index: 62; display: grid; place-items: center; background: color-mix(in srgb, var(--theme--background) 45%, transparent); }
.pm-dup {
	display: flex; flex-direction: column; gap: 10px; width: 280px; max-width: calc(100vw - 32px); padding: 14px;
	background: var(--d1-surface, var(--theme--background)); color: var(--theme--foreground);
	border: 1px solid var(--d1-line); border-radius: 12px; box-shadow: var(--d1-shadow-lg, 0 10px 30px rgb(0 0 0 / 0.25));
	font-size: var(--fs-md, 13px);
}
.ttl { font-weight: 700; }
.row { display: flex; align-items: center; gap: 6px; }
.x { color: var(--d1-dim); font-weight: 700; }
input {
	width: 90px; padding: 6px 10px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--d1-surface)); color: inherit; font: inherit;
}
input:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); box-shadow: 0 0 0 2px var(--d1-tint); }
input[aria-invalid='true'] { border-color: var(--d1-bad); }
.bad { margin: 0; color: var(--d1-bad); font-size: var(--fs-sm, 12px); }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
</style>
