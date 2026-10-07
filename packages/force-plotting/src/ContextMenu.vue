<script setup lang="ts">
// A small right-click menu, host-agnostic (no host imports): the host decides when to open it and
// what the items do, this only places it, closes it and handles the keyboard. Fixed-position at the
// client coords it is given, then clamped into the viewport once its real size is known. Closes on
// a press outside, Escape, scroll, window blur/resize, and after an item runs. A disabled item
// stays visible with its `hint` (title + a muted line) so the user learns why it is unavailable.
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

export interface ContextMenuItem { label: string; hint?: string; disabled?: boolean; run: () => void }

const props = defineProps<{ x: number; y: number; items: ContextMenuItem[] }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const rootEl = ref<HTMLElement | null>(null);
const left = ref(props.x), top = ref(props.y);
const MARGIN = 8;

function enabledButtons(): HTMLButtonElement[] {
	const root = rootEl.value;
	return root ? Array.from(root.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([aria-disabled="true"])')) : [];
}

function clamp() {
	const el = rootEl.value;
	if (!el) return;
	const r = el.getBoundingClientRect();
	left.value = Math.max(MARGIN, Math.min(props.x, window.innerWidth - r.width - MARGIN));
	top.value = Math.max(MARGIN, Math.min(props.y, window.innerHeight - r.height - MARGIN));
}

function activate(it: ContextMenuItem) {
	if (it.disabled) return;
	try { it.run(); } finally { emit('close'); }
}

function onKey(e: KeyboardEvent) {
	// stopPropagation + preventDefault: the host's Escape handler (the dashboard clears the pinned
	// marker on Escape) must see this press as already used up by closing the menu.
	if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); emit('close'); return; }
	if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
	const btns = enabledButtons();
	if (!btns.length) return;
	e.preventDefault();
	const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
	const step = e.key === 'ArrowDown' ? 1 : -1;
	btns[cur < 0 ? (step > 0 ? 0 : btns.length - 1) : (cur + step + btns.length) % btns.length].focus();
}

// Escape also works while focus is elsewhere (the menu is opened by the mouse), so the key listener
// sits on the window; onKey ignores everything but Escape and the arrows.
function onPointerDown(e: PointerEvent) {
	if (rootEl.value && e.target instanceof Node && rootEl.value.contains(e.target)) return;
	emit('close');
}
const close = () => emit('close');

onMounted(() => {
	window.addEventListener('pointerdown', onPointerDown, true);
	window.addEventListener('keydown', onKey, true);
	window.addEventListener('scroll', close, true);
	window.addEventListener('blur', close);
	window.addEventListener('resize', close);
	nextTick(() => { clamp(); enabledButtons()[0]?.focus({ preventScroll: true }); });
});
onBeforeUnmount(() => {
	window.removeEventListener('pointerdown', onPointerDown, true);
	window.removeEventListener('keydown', onKey, true);
	window.removeEventListener('scroll', close, true);
	window.removeEventListener('blur', close);
	window.removeEventListener('resize', close);
});
</script>

<template>
	<div ref="rootEl" class="fp-ctx" role="menu" :style="{ left: left + 'px', top: top + 'px' }"
		@contextmenu.prevent>
		<button v-for="(it, i) in items" :key="i" type="button" role="menuitem" class="fp-ctx-item"
			:class="{ disabled: it.disabled }" :aria-disabled="it.disabled ? 'true' : undefined"
			:tabindex="it.disabled ? -1 : 0" :title="it.disabled ? it.hint : undefined" @click="activate(it)">
			<span>{{ it.label }}</span>
			<span v-if="it.disabled && it.hint" class="fp-ctx-hint">{{ it.hint }}</span>
		</button>
	</div>
</template>

<style scoped>
.fp-ctx {
	position: fixed; z-index: 1000; min-width: 190px; max-width: 280px; padding: 4px;
	display: flex; flex-direction: column;
	background: var(--bg-2, var(--theme--background, #fff));
	border: 1px solid var(--border, var(--theme--border-color-subdued, #e7ebf0)); border-radius: 9px;
	box-shadow: 0 14px 40px rgba(15, 23, 42, 0.22);
	color: var(--text, var(--theme--foreground, #1e293b));
}
.fp-ctx-item {
	display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 6px 9px; text-align: left;
	font: inherit; font-size: var(--fs-md, 13px); color: inherit; cursor: pointer;
	background: transparent; border: 0; border-radius: 6px;
}
.fp-ctx-item:hover:not(.disabled), .fp-ctx-item:focus-visible:not(.disabled) {
	background: var(--surface-2, var(--theme--background-normal, #f0f4f9)); outline: none;
}
.fp-ctx-item.disabled { cursor: default; color: var(--text-dim, var(--theme--foreground-subdued, #6b7684)); opacity: 0.75; }
.fp-ctx-hint { font-size: var(--fs-xs, 11px); color: var(--text-dim, var(--theme--foreground-subdued, #6b7684)); }
</style>
