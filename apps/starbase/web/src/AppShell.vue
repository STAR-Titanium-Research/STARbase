<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Finder, useFinderShortcut, usePins, type SectionId } from '@d1/ui';
import { openScan } from '@d1/starbase-pages';
import BrandLogo from './BrandLogo.vue';
import ShellSidebar from './ShellSidebar.vue';
import { useWindowWidth } from './narrow';
import { backdropDismiss } from './backdropDismiss';
import { returnFocusToMenu } from './sheetFocus';
import { DIALOG_SELECTOR, shortcutMode, useShellLayout } from './shellLayout';
import { applyTheme, cacheTheme } from './appearance';

// STARbase's chrome around every signed-in page (spec §3.3; explorer-sidebar-b2 decisions 7 and 8). The
// sidebar's layout follows the window width and the person's saved choice (shellLayout.ts):
//   >= 1000 px   a 224px column, or a 60px rail when they collapsed it ([ and ] too);
//   768-999 px   a rail; expanding opens the sidebar over the page, closing on Esc, a backdrop click or a page;
//   < 768 px     a top bar whose Menu button opens the sidebar as a full-height sheet.
// The overlay and the sheet are the same aria-modal dialog (the page behind is inert, Tab wraps inside, so
// Ctrl+K stays shut while one is open). The finder is shared by all three.
const width = useWindowWidth();
const { prefs, setPref } = usePins();
const shell = useShellLayout({ width, prefs, setPref });
const phone = computed(() => shell.layout.value.phone);

const sheetOpen = ref(false);
const modalOpen = computed(() => (phone.value ? sheetOpen.value : shell.overlayOpen.value));
const menuBtn = ref<HTMLButtonElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
const sideEl = ref<HTMLElement | null>(null);
const sheetEl = ref<HTMLElement | null>(null);
let handedOff = false;
const route = useRoute();
const { finderOpen, openFinder, closeFinder } = useFinderShortcut();

const closeModal = () => {
	if (phone.value) sheetOpen.value = false;
	else shell.closeOverlay();
};
const scanFromFinder = () => {
	closeFinder();
	openScan();
};
// Backdrop: remember where the press started; the click closes only if it also ended there.
let pressedBackdrop = false;
const onBackdropDown = (e: PointerEvent) => (pressedBackdrop = e.target === e.currentTarget);
const onBackdropClick = (e: MouseEvent) => {
	const started = pressedBackdrop;
	pressedBackdrop = false;
	if (backdropDismiss(started, e.target === e.currentTarget)) closeModal();
};
const findFromModal = () => {
	handedOff = true;
	closeModal();
	openFinder();
};

// The rail's own controls ask for a layout; the sheet and the overlay close when the choice is made there.
const onRequestMode = (mode: 'expanded' | 'rail', sectionId?: SectionId) => shell.requestMode(mode, sectionId);

// Theme: the saved choice paints <html> (theme.css), and is remembered here for the next load.
watch(
	() => prefs.value.theme,
	(theme) => {
		applyTheme(document.documentElement, theme);
		cacheTheme(theme);
	},
	{ immediate: true },
);

// Focus: into the dialog on open (the sheet's close button; the overlay's collapse button), and back to what
// opened it on every way of closing it (the Menu button; the element that had focus, else the rail's Expand).
let opener: HTMLElement | null = null;
watch(modalOpen, async (open) => {
	if (open) {
		handedOff = false;
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		await nextTick();
		const first = closeBtn.value ?? sheetEl.value?.querySelector<HTMLElement>('button[aria-label="Collapse the sidebar"], ' + FOCUSABLE);
		first?.focus();
	} else {
		await nextTick();
		if (phone.value) {
			if (returnFocusToMenu({ narrow: phone.value, handedOff })) menuBtn.value?.focus();
		} else if (!handedOff) {
			const back = opener?.isConnected ? opener : sideEl.value?.querySelector<HTMLElement>('button[aria-label="Expand sidebar"]');
			back?.focus();
		}
		handedOff = false;
		opener = null;
	}
});

// The dialog closes when a page is chosen, and when the window leaves the layout that has it.
watch(() => route.fullPath, () => {
	sheetOpen.value = false;
	shell.closeOverlay();
});
watch(phone, (isPhone) => {
	if (!isPhone) sheetOpen.value = false;
});

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
const onKey = (e: KeyboardEvent) => {
	if (modalOpen.value) {
		if (e.key === 'Escape') closeModal();
		if (e.key === 'Tab' && sheetEl.value) {
			// Tab wraps inside the dialog (the page behind is inert, so this is only the edge, where focus would leave for the browser's own chrome).
			const items = [...sheetEl.value.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (!first || !last) return;
			if (e.shiftKey && (active === first || !sheetEl.value.contains(active))) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && (active === last || !sheetEl.value.contains(active))) { e.preventDefault(); first.focus(); }
		}
		return;
	}
	// [ and ] collapse and expand the sidebar (not on a phone, not while typing or with a dialog open).
	if (phone.value) return;
	const mode = shortcutMode(e, !!document.querySelector(DIALOG_SELECTOR));
	if (mode) onRequestMode(mode);
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
	<div class="sb-shell" :class="{ phone, rail: shell.mode.value === 'rail' }" :style="{ '--sb-side-w': shell.sideWidth.value }">
		<aside v-if="!phone" ref="sideEl" class="sb-side d1-kit" aria-label="STARbase" :inert="modalOpen">
			<ShellSidebar
				:mode="shell.mode.value"
				collapsible
				:open-section="shell.openSection.value"
				@open-finder="openFinder"
				@request-mode="onRequestMode"
			/>
		</aside>
		<header v-else class="sb-topbar" :inert="sheetOpen">
			<button ref="menuBtn" type="button" class="sb-icon-btn" aria-label="Menu" :aria-expanded="sheetOpen" @click="sheetOpen = true"><v-icon name="menu" /></button>
			<router-link to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo compact /></router-link>
			<button type="button" class="sb-icon-btn" aria-label="Find a record" @click="openFinder"><v-icon name="search" /></button>
		</header>

		<main class="sb-content" :inert="modalOpen"><router-view /></main>

		<div v-if="modalOpen" class="sb-sheet-backdrop" :class="{ overlay: !phone }" @pointerdown="onBackdropDown" @click="onBackdropClick">
			<div ref="sheetEl" class="sb-sheet d1-kit" :class="{ overlay: !phone }" role="dialog" aria-modal="true" aria-label="Pages">
				<div v-if="phone" class="sb-sheet-head">
					<BrandLogo on-dark />
					<button ref="closeBtn" type="button" class="sb-icon-btn" aria-label="Close the menu" @click="sheetOpen = false"><v-icon name="close" /></button>
				</div>
				<ShellSidebar
					mode="expanded"
					:collapsible="!phone"
					:brand="!phone"
					:open-section="shell.openSection.value"
					@open-finder="findFromModal"
					@request-mode="onRequestMode"
				/>
			</div>
		</div>

		<Finder v-if="finderOpen" can-scan @close="closeFinder" @scan="scanFromFinder" />
	</div>
</template>

<style scoped>
.sb-shell { display: grid; grid-template-columns: var(--sb-side-w, 224px) minmax(0, 1fr); height: 100dvh; }
.sb-side {
	display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow-x: hidden; overflow-y: auto;
	background: var(--d1-side-ground); border-right: 1px solid var(--d1-side-hairline);
}
.sb-brand { display: flex; align-items: center; height: 64px; padding: 0 16px; flex: none; text-decoration: none; }
.sb-content { min-width: 0; height: 100dvh; overflow-y: auto; }

.sb-shell.phone { grid-template-columns: minmax(0, 1fr); grid-template-rows: 56px minmax(0, 1fr); }
.sb-shell.phone .sb-content { height: calc(100dvh - 56px); }
@media (max-width: 767px) {
	.sb-content { overflow-x: hidden; } /* a wide child never gives the page a sideways scroll on a phone */
}
.sb-topbar {
	display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 8px;
	background: var(--theme--background-subdued); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.sb-topbar .sb-brand { height: 56px; padding: 0 8px; }
.sb-icon-btn {
	display: inline-grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 10px;
	background: none; color: var(--theme--foreground); cursor: pointer;
}
.sb-icon-btn:focus-visible { outline: 2px solid var(--theme--primary); }
.sb-sheet-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.4); }
.sb-sheet-backdrop.overlay { background: rgba(13, 17, 23, 0.35); }
.sb-sheet {
	display: flex; flex-direction: column; width: min(340px, 88vw); height: 100dvh; overflow-y: auto;
	background: var(--d1-side-ground); box-shadow: 4px 0 24px rgba(0, 0, 0, 0.3);
}
/* Over the page at 768-999 px: the expanded sidebar's own 224px, on top of the rail it opened from. */
.sb-sheet.overlay { width: 224px; }
.sb-sheet-head { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 8px 0 16px; flex: none; }
.sb-sheet-head .sb-icon-btn { color: var(--d1-side-text); }
.sb-sheet-head .sb-icon-btn:focus-visible { outline-color: var(--d1-side-bar); }
</style>
