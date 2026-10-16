<script setup lang="ts">
// One row of the expanded sidebar: a page, a saved view or a pin. The row is the link; the pin and
// "⋯" buttons sit on it and show on hover, on focus, and always on touch screens. A pinned row has
// its lit pin button on the left (click to unpin) and a grip that shows on hover, and can be dragged
// and moved with Alt+Up / Alt+Down. The row only reports what was asked; SidebarExpanded decides.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppLink from '../components/AppLink.vue';
import { linkHref } from '../links';
import NavIcon from './NavIcon.vue';
import type { ResolvedPin, SidebarLink } from './sidebarModel';

const props = withDefaults(
	defineProps<{
		item: SidebarLink | ResolvedPin;
		variant: 'section' | 'pinned';
		pinned: boolean;
		current: boolean;
		// False until the person's pins have loaded: no pin button, no drag, no pin item in the menu.
		pinsReady?: boolean;
		// A saved view listed under its index page: indented, no icon of its own.
		nested?: boolean;
		// Home: a plain link, with no "⋯" button.
		plain?: boolean;
		// This row's menu is open.
		menuOpen?: boolean;
		dragging?: boolean;
		// A count drawn after the label (the Inbox's new files); '' draws none. `badgeLabel` is what a screen reader hears for it.
		badge?: string;
		badgeLabel?: string;
	}>(),
	{ pinsReady: true, nested: false, plain: false, menuOpen: false, dragging: false, badge: '', badgeLabel: '' },
);

const emit = defineEmits<{
	(e: 'toggle-pin'): void;
	(e: 'open-menu', anchor: DOMRect): void;
	(e: 'dragstart', ev: DragEvent): void;
	(e: 'dragend'): void;
	(e: 'move', delta: -1 | 1): void;
}>();

const router = useRouter();

const isPin = computed(() => 'ref' in props.item);
const label = computed(() => props.item.label);
const hint = computed(() => (isPin.value ? (props.item as ResolvedPin).hint : null));
const fullLabel = computed(() => (hint.value ? `${label.value} · ${hint.value}` : label.value));
const newTab = computed(() => !isPin.value && (props.item as SidebarLink).newTab);
const canPin = computed(() => props.pinsReady && (isPin.value || (props.item as SidebarLink).pin !== null));

const el = ref<HTMLElement | null>(null);
const menuButton = ref<HTMLButtonElement | null>(null);

function openMenu() {
	if (el.value) emit('open-menu', el.value.getBoundingClientRect());
}

// Right-click opens the "⋯" menu; Home has none, so it keeps the browser's own.
function onContextMenu(e: MouseEvent) {
	if (props.plain) return;
	e.preventDefault();
	openMenu();
}

function onKeydown(e: KeyboardEvent) {
	if (props.variant === 'pinned' && canPin.value && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
		e.preventDefault();
		emit('move', e.key === 'ArrowUp' ? -1 : 1);
	}
}

function onDragStart(e: DragEvent) {
	if (!canPin.value) return;
	if (e.dataTransfer) {
		e.dataTransfer.effectAllowed = 'move';
		// Firefox only starts a drag that carries some data.
		e.dataTransfer.setData('text/plain', fullLabel.value);
	}
	emit('dragstart', e);
}

defineExpose({
	focusMenuButton: () => menuButton.value?.focus(),
	focusLink: () => el.value?.querySelector<HTMLElement>('a')?.focus(),
});
</script>

<template>
	<div
		ref="el"
		class="row"
		:class="{ current, pinned: variant === 'pinned', nested, dragging, 'menu-open': menuOpen }"
		:draggable="canPin"
		@dragstart="onDragStart"
		@dragend="emit('dragend')"
		@contextmenu="onContextMenu"
		@keydown="onKeydown"
	>
		<span v-if="variant === 'pinned' && canPin" class="grip" aria-hidden="true"><NavIcon name="grip-vertical" :size="12" /></span>
		<button
			v-if="variant === 'pinned' && canPin"
			type="button"
			class="btn lit"
			:aria-pressed="true"
			:aria-label="`Pin ${fullLabel}`"
			title="Unpin"
			@click="emit('toggle-pin')"
		>
			<NavIcon name="pin" />
		</button>

		<a
			v-if="newTab"
			class="link"
			draggable="false"
			:href="linkHref(item.to, router)"
			target="_blank"
			rel="noopener"
			:title="fullLabel"
		>
			<NavIcon v-if="!nested" :name="item.icon" />
			<span class="label">{{ label }}</span>
			<span class="ext" aria-hidden="true"><NavIcon name="external-link" :size="12" /></span>
			<span class="sr">(opens in a new tab)</span>
		</a>
		<AppLink
			v-else
			class="link"
			draggable="false"
			active-class=""
			exact-active-class=""
			:to="item.to"
			:title="fullLabel"
			:aria-current="current ? 'page' : undefined"
		>
			<NavIcon v-if="!nested" :name="item.icon" />
			<span class="label">{{ label }}</span>
			<span v-if="hint" class="hint">{{ hint }}</span>
			<span v-if="badge" class="badge" data-test="nav-badge"><span aria-hidden="true">{{ badge }}</span><span class="sr">{{ badgeLabel || badge }}</span></span>
		</AppLink>

		<span class="actions">
			<button
				v-if="variant === 'section' && canPin"
				type="button"
				class="btn"
				:class="{ lit: pinned }"
				:aria-pressed="pinned"
				:aria-label="`Pin ${fullLabel}`"
				:title="pinned ? 'Unpin' : 'Pin'"
				@click="emit('toggle-pin')"
			>
				<NavIcon name="pin" />
			</button>
			<button
				v-if="!plain"
				ref="menuButton"
				type="button"
				class="btn"
				aria-haspopup="menu"
				:aria-expanded="menuOpen"
				:aria-label="`More actions for ${fullLabel}`"
				title="More"
				@click="openMenu"
			>
				<NavIcon name="ellipsis" />
			</button>
		</span>
	</div>
</template>

<style scoped>
.row {
	position: relative;
	display: flex;
	align-items: center;
	min-height: 34px;
	padding: 0 6px 0 8px;
	border-radius: 7px;
	color: var(--d1-side-text);
}
.row:hover,
.row:focus-within,
.row.menu-open {
	background: var(--d1-side-hover);
}
.row.current {
	background: var(--d1-side-current);
	color: #fff;
}
/* The current page: a 3px bar on the row's left edge. */
.row.current::before {
	content: '';
	position: absolute;
	left: 0;
	top: 6px;
	bottom: 6px;
	width: 3px;
	border-radius: 2px;
	background: var(--d1-side-bar);
}
.row.dragging { opacity: 0.45; }
.row.nested { padding-left: 34px; min-height: 30px; font-size: var(--fs-sm, 12px); }

.link {
	display: flex;
	flex: 1 1 auto;
	align-items: center;
	gap: 10px;
	min-width: 0;
	min-height: 34px;
	color: inherit;
	text-decoration: none;
	/* The row is the drag handle; the anchor itself is not draggable. */
	-webkit-user-drag: none;
}
.link:focus-visible { outline: 2px solid var(--d1-side-bar); outline-offset: 1px; border-radius: 6px; }
.link :deep(.d1-nav-icon) { color: var(--d1-side-dim); }
.row.current .link :deep(.d1-nav-icon),
.row:hover .link :deep(.d1-nav-icon) { color: #fff; }

.label { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A saved view's index page, in grey after its name. */
.hint { min-width: 0; flex: 0 100 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm, 12px); color: var(--d1-side-dim); }
.ext { display: inline-flex; color: var(--d1-side-dim); }
/* The Inbox's count: a small pill at the row's end, in the sidebar's accent. */
.badge {
	flex: none; margin-left: auto; min-width: 20px; padding: 0 6px; border-radius: 99px; background: var(--d1-side-bar); color: #fff;
	font-size: var(--fs-xs, 11px); font-weight: 700; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums;
}

.grip {
	position: absolute;
	left: 0;
	top: 50%;
	display: none;
	transform: translateY(-50%);
	color: var(--d1-side-sub);
	cursor: grab;
}
.row.pinned { padding-left: 14px; }
.row.pinned:hover .grip { display: inline-flex; }

/* The buttons lie over the end of the label, on the row's own hover ground, so the label keeps its width. */
.actions {
	position: absolute;
	right: 4px;
	top: 3px;
	bottom: 3px;
	display: flex;
	align-items: center;
	gap: 2px;
	padding-left: 6px;
	border-radius: 6px;
	opacity: 0;
	pointer-events: none;
	background: inherit;
}
.row:hover .actions,
.row:focus-within .actions,
.row.menu-open .actions {
	opacity: 1;
	pointer-events: auto;
}
.row.current .actions { background: var(--d1-side-current); }
.btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: none;
	width: 28px;
	height: 28px;
	padding: 0;
	border: 0;
	border-radius: 6px;
	background: none;
	color: var(--d1-side-dim);
	cursor: pointer;
}
.btn:hover { background: var(--d1-side-hairline); color: #fff; }
.btn:focus-visible { outline: 2px solid var(--d1-side-bar); outline-offset: -2px; }
.btn.lit { color: var(--d1-side-bar); }
.btn.lit :deep(svg) { fill: currentColor; }
/* A pinned row's pin button is part of the row, not an overlay: always shown. */
.row.pinned > .btn { margin-right: 4px; }

.sr {
	position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
	clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* No hover on a touch screen: the buttons are always there. */
@media (hover: none) {
	.actions { position: static; opacity: 1; pointer-events: auto; padding-left: 0; background: none; }
	.row { padding-right: 2px; }
}
</style>
