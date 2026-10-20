<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { POPOVER_BELOW, contentWidth, isRailToggleKey, readRailOpen, writeRailOpen } from './viewRail';
import './tokens.css';

// The View rail: one small hanging card for HOW a page is shown (layout, density, sort, what to hide),
// the mirror of RecordRail (DESIGN.md section 5). Index pages and record pages both use it; each fills
// the default slot with <ViewRailSection label="..."> blocks holding only the settings that apply
// (SegmentedControl, a select). The component owns only the card: lid, collapse and the collapsed tab.
//
// Props
//   storageKey   localStorage key that remembers open or closed on this device (wrapped in try/catch).
//   defaultOpen  open or closed when nothing is remembered yet (default false). Index pages open it from
//                1500px of content width, record pages leave it closed.
//   summary      the collapsed tab's text after "View", e.g. "Normal · Created ↓".
//   modified     true when the view is not the default: a dot on the tab and on the popover button.
// Slots
//   default      the sections.
//
// States
//   open       the 220px card: a 40px lid (sliders icon, "View", collapse button), then the sections.
//   collapsed  a 36px vertical tab with the icon, the dot and "View · summary". Click opens it.
//   popover    under 1100px of content width a "View" button opens the same sections in a popover.
//              The width is that of the nearest ancestor that is an inline-size container (RecordLayout
//              is one), else the window. Not remembered: it is closed on every visit.
// `\` toggles open or collapsed (or the popover), unless a field has the keyboard.
//
// Placement is the page's: the root is a grid item that sticks at the page's header offset
// (--d1-sticky-top, else --d1-header-offset) and is only as tall as its content.
const props = withDefaults(defineProps<{ storageKey: string; defaultOpen?: boolean; summary?: string; modified?: boolean }>(), { defaultOpen: false });

const root = ref<HTMLElement | null>(null);
const open = ref(readRailOpen(props.storageKey, props.defaultOpen));
const narrow = ref(false);
const popover = ref(false);

function setOpen(value: boolean): void {
	open.value = value;
	writeRailOpen(props.storageKey, value);
}
function toggle(): void {
	if (narrow.value) popover.value = !popover.value;
	else setOpen(!open.value);
}

function onKey(e: KeyboardEvent): void {
	if (e.key === 'Escape' && popover.value) {
		popover.value = false;
		return;
	}
	if (!isRailToggleKey(e)) return;
	e.preventDefault();
	toggle();
}
// A click anywhere else closes the popover.
function onDocumentClick(e: MouseEvent): void {
	if (popover.value && root.value && !root.value.contains(e.target as Node)) popover.value = false;
}

let observer: ResizeObserver | null = null;
function measure(): void {
	if (root.value) narrow.value = contentWidth(root.value) < POPOVER_BELOW;
	if (!narrow.value) popover.value = false;
}
onMounted(() => {
	window.addEventListener('keydown', onKey);
	document.addEventListener('click', onDocumentClick);
	measure();
	if (typeof ResizeObserver !== 'undefined' && root.value) {
		// The container itself is what changes size; the window is the fallback when there is none.
		let p: HTMLElement | null = root.value.parentElement;
		while (p && !['inline-size', 'size'].includes(getComputedStyle(p).containerType)) p = p.parentElement;
		observer = new ResizeObserver(measure);
		observer.observe(p ?? document.documentElement);
	}
});
onBeforeUnmount(() => {
	window.removeEventListener('keydown', onKey);
	document.removeEventListener('click', onDocumentClick);
	observer?.disconnect();
});
</script>

<template>
	<div ref="root" class="d1-view-rail d1-kit" :class="{ narrow }">
		<template v-if="narrow">
			<button type="button" class="pop-button" aria-haspopup="dialog" :aria-expanded="popover" title="View settings (\)" @click="toggle">
				<v-icon name="tune" small />View<i v-if="modified" class="dot" aria-label="Changed from the default" />
			</button>
			<div v-if="popover" class="card pop" role="dialog" aria-label="View settings">
				<slot />
			</div>
		</template>

		<div v-else-if="open" class="card">
			<div class="lid">
				<v-icon name="tune" small />
				<span class="title">View</span>
				<button type="button" class="collapse" aria-label="Collapse the View rail" title="Collapse (\)" @click="setOpen(false)"><v-icon name="chevron_right" small /></button>
			</div>
			<slot />
		</div>

		<button v-else type="button" class="tab" :aria-label="`Open the View rail${summary ? `: ${summary}` : ''}`" title="Open the View rail (\)" @click="setOpen(true)">
			<v-icon name="tune" small />
			<i v-if="modified" class="dot" aria-label="Changed from the default" />
			<span class="vertical">{{ summary ? `View · ${summary}` : 'View' }}</span>
		</button>
	</div>
</template>

<style scoped>
.d1-view-rail {
	position: sticky;
	top: var(--d1-sticky-top, var(--d1-header-offset, 0px));
	align-self: start;
	justify-self: end;
	min-width: 0;
	z-index: 10;
}
/* Open: a hanging card like RecordRail's. */
.card {
	box-sizing: border-box;
	width: 220px;
	display: flex;
	flex-direction: column;
	background: var(--d1-surface, var(--theme--background));
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px);
	box-shadow: var(--d1-shadow, none);
	font-size: var(--fs-md, 13px);
	color: var(--theme--foreground);
}
.lid {
	display: flex;
	align-items: center;
	gap: 6px;
	height: 40px;
	padding: 0 6px 0 12px;
	/* The card does not clip (a section's dropdown, the index page's Columns, hangs outside it), so the lid rounds its own top corners. */
	border-radius: calc(var(--d1-radius, 12px) - 1px) calc(var(--d1-radius, 12px) - 1px) 0 0;
	background: var(--d1-tile, var(--theme--background-subdued));
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
.title { font-weight: 650; }
.collapse {
	margin-left: auto;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border: 0;
	border-radius: 6px;
	background: none;
	color: var(--d1-dim, var(--theme--foreground-subdued));
	cursor: pointer;
}
.collapse:hover { background: var(--d1-line, var(--theme--border-color-subdued)); color: var(--theme--foreground); }
/* Collapsed: the 36px tab. */
.tab {
	box-sizing: border-box;
	width: 36px;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
	padding: 10px 0 12px;
	background: var(--d1-surface, var(--theme--background));
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: var(--d1-radius, 12px);
	box-shadow: var(--d1-shadow, none);
	color: var(--theme--foreground);
	font: inherit;
	font-size: var(--fs-sm, 12px);
	font-weight: 650;
	cursor: pointer;
}
.tab:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.vertical { writing-mode: vertical-rl; max-height: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--d1-accent, var(--theme--primary)); }
/* Under 1100px: a button and a popover under it. */
.pop-button {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 30px;
	padding: 0 12px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 8px;
	background: var(--d1-tile, var(--theme--background-subdued));
	color: var(--theme--foreground);
	font: inherit;
	font-size: var(--fs-sm, 12px);
	font-weight: 600;
	cursor: pointer;
}
.pop-button:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.pop { position: absolute; right: 0; top: calc(100% + 6px); max-width: calc(100vw - 32px); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
.collapse:focus-visible, .tab:focus-visible, .pop-button:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.narrow { position: relative; top: auto; }
</style>
