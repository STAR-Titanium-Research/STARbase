<script setup lang="ts">
// The "⋯" menu of a sidebar row (spec decision 6). It opens to the right of the sidebar, level with
// the row, never on top of the list: position: fixed at `edge + 4px` (the sidebar's right edge; the
// anchor's right edge when the caller gives none) and `anchor.top - 4`, kept inside the window.
// It is teleported to <body>, so no ancestor's overflow or transform clips or moves it.
//
// A real role="menu": the first enabled item is focused on open, Up/Down/Home/End move, Esc and Tab
// close it, a click outside closes it. The caller returns focus to the "⋯" button on `close`.
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import NavIcon from './NavIcon.vue';
import type { NavIconName } from './navIcons';

export interface NavRowMenuItem {
	id: string;
	label: string;
	icon: NavIconName;
	hint?: string;
	disabled?: boolean;
}

const props = defineProps<{
	open: boolean;
	anchor: DOMRect | null;
	items: NavRowMenuItem[];
	// The sidebar's right edge, in viewport pixels.
	edge?: number;
}>();
const emit = defineEmits<{ (e: 'choose', id: string): void; (e: 'close'): void }>();

const GAP = 4;
const MARGIN = 8;

const menu = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });

function place() {
	const a = props.anchor;
	if (!a) return;
	const w = menu.value?.offsetWidth ?? 200;
	const h = menu.value?.offsetHeight ?? 0;
	const left = Math.max(MARGIN, Math.min((props.edge ?? a.right) + GAP, window.innerWidth - w - MARGIN));
	const top = Math.max(MARGIN, Math.min(a.top - GAP, window.innerHeight - h - MARGIN));
	pos.value = { left, top };
}

const buttons = () => [...(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const enabled = () => buttons().filter((b) => b.getAttribute('aria-disabled') !== 'true');

function onDocumentPointerDown(e: PointerEvent) {
	const t = e.target as Element | null;
	if (!t || menu.value?.contains(t)) return;
	// The "⋯" button that opened the menu toggles it itself.
	if (t.closest('[aria-haspopup="menu"]')) return;
	emit('close');
}

function onWindowChange() {
	// A resize would leave the menu beside the wrong row.
	emit('close');
}

function listen(on: boolean) {
	if (typeof document === 'undefined') return; // server render
	const fn = on ? 'addEventListener' : 'removeEventListener';
	document[fn]('pointerdown', onDocumentPointerDown, true);
	window[fn]('resize', onWindowChange);
}

watch(
	() => props.open,
	async (open) => {
		listen(open);
		if (!open) return;
		place();
		await nextTick();
		place();
		enabled()[0]?.focus();
	},
	{ immediate: true },
);
onBeforeUnmount(() => listen(false));

function onKeydown(e: KeyboardEvent) {
	const list = enabled();
	const at = list.indexOf(document.activeElement as HTMLElement);
	const focus = (i: number) => {
		e.preventDefault();
		list[(i + list.length) % list.length]?.focus();
	};
	if (e.key === 'Escape') {
		e.preventDefault();
		// Not the sheet's or the page's Esc as well.
		e.stopPropagation();
		emit('close');
	} else if (e.key === 'ArrowDown') focus(at + 1);
	else if (e.key === 'ArrowUp') focus(at <= 0 ? list.length - 1 : at - 1);
	else if (e.key === 'Home') focus(0);
	else if (e.key === 'End') focus(list.length - 1);
	else if (e.key === 'Tab') emit('close');
}

function choose(item: NavRowMenuItem) {
	if (item.disabled) return;
	emit('choose', item.id);
}
</script>

<template>
	<Teleport to="body">
		<div
			v-if="open"
			ref="menu"
			class="d1-side-menu"
			role="menu"
			aria-label="Row actions"
			:style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
			@keydown="onKeydown"
		>
			<button
				v-for="item in items"
				:key="item.id"
				type="button"
				role="menuitem"
				class="item"
				:aria-disabled="item.disabled ? 'true' : undefined"
				@click="choose(item)"
			>
				<NavIcon :name="item.icon" />
				<span class="text">{{ item.label }}</span>
				<span v-if="item.hint" class="hint">{{ item.hint }}</span>
			</button>
		</div>
	</Teleport>
</template>

<style scoped>
.d1-side-menu {
	position: fixed;
	z-index: 1000;
	min-width: 196px;
	padding: 4px;
	border: 1px solid var(--d1-side-hairline);
	border-radius: 10px;
	background: var(--d1-side-ground);
	color: var(--d1-side-text);
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
	font-family: inherit;
	font-size: var(--fs-md, 13px);
}
.item {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 34px;
	padding: 0 10px;
	border: 0;
	border-radius: 6px;
	background: none;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}
.item :deep(.d1-nav-icon) { color: var(--d1-side-dim); }
.item:hover,
.item:focus-visible { background: var(--d1-side-hover); outline: none; }
.item:focus-visible { box-shadow: inset 0 0 0 2px var(--d1-side-bar); }
.item[aria-disabled='true'] { color: var(--d1-side-sub); cursor: default; }
.item[aria-disabled='true']:hover { background: none; }
.item[aria-disabled='true'] :deep(.d1-nav-icon) { color: var(--d1-side-sub); }
.text { flex: 1 1 auto; white-space: nowrap; }
.hint { font-size: var(--fs-sm, 12px); color: var(--d1-side-sub); white-space: nowrap; }
</style>
