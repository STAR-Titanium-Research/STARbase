import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { layoutFor, type NavPrefs, type SectionId, type ShellLayout } from '@d1/ui';

// The shell's sidebar layout (explorer-sidebar-b2 spec, decisions 7 and 8): which mode the sidebar is
// in at this window width, how wide its column is, and what a `request-mode` from the sidebar does.
// Pure Vue (refs and a callback), so it is tested without a DOM.
//
//   >= 1000 px   the saved choice (expanded / rail); a request saves it as `sidebarCollapsed`.
//   768-999 px   a rail (when "collapse automatically" is on); expanding opens an overlay and
//                saves nothing. The overlay closes when the window leaves that range.
//   < 768 px     the phone sheet (the shell's own state; it never reaches here).

export const EXPANDED_COLUMN_PX = 224;
export const RAIL_COLUMN_PX = 60;

export interface ShellLayoutState {
	layout: ComputedRef<ShellLayout>;
	// The mode the sidebar column is drawn in (expanded on a phone, where it is only the sheet).
	mode: ComputedRef<'expanded' | 'rail'>;
	sideWidth: ComputedRef<string>;
	overlayOpen: ComputedRef<boolean>;
	// The section the last expand request named, for the expanded sidebar to open (null: its own choice).
	openSection: Ref<SectionId | null>;
	requestMode(mode: 'expanded' | 'rail', sectionId?: SectionId): void;
	closeOverlay(): void;
}

export function useShellLayout(o: {
	width: Ref<number>;
	prefs: Ref<Pick<NavPrefs, 'sidebarCollapsed' | 'autoCollapse'>>;
	setPref: (k: 'sidebarCollapsed', v: boolean) => unknown;
}): ShellLayoutState {
	const layout = computed(() =>
		layoutFor({ width: o.width.value, savedRail: o.prefs.value.sidebarCollapsed, autoCollapse: o.prefs.value.autoCollapse }),
	);
	const mode = computed(() => layout.value.mode);
	const sideWidth = computed(() => `${mode.value === 'rail' ? RAIL_COLUMN_PX : EXPANDED_COLUMN_PX}px`);

	// Asked for, and only in force while the layout still has an overlay: leaving the range closes it
	// for good (coming back to 900 px does not reopen it), and nothing here is ever written to prefs.
	const asked = ref(false);
	const overlayOpen = computed(() => asked.value && layout.value.overlay);
	watch(
		() => layout.value.overlay,
		(overlay) => {
			if (!overlay) asked.value = false;
		},
		{ flush: 'sync' },
	);

	const openSection = ref<SectionId | null>(null);

	function requestMode(next: 'expanded' | 'rail', sectionId?: SectionId): void {
		if (layout.value.phone) return;
		if (layout.value.overlay) {
			openSection.value = next === 'expanded' ? (sectionId ?? null) : null;
			asked.value = next === 'expanded';
			return;
		}
		openSection.value = next === 'expanded' ? (sectionId ?? null) : null;
		void o.setPref('sidebarCollapsed', next === 'rail');
	}

	return { layout, mode, sideWidth, overlayOpen, openSection, requestMode, closeOverlay: () => (asked.value = false) };
}

// `[` collapses and `]` expands, but never while someone types, holds a modifier, or a dialog is open.
export function shortcutMode(
	e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target' | 'defaultPrevented'>,
	dialogOpen: boolean,
): 'expanded' | 'rail' | null {
	if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || dialogOpen) return null;
	if (e.key !== '[' && e.key !== ']') return null;
	if (inTextField(e.target)) return null;
	return e.key === '[' ? 'rail' : 'expanded';
}

function inTextField(target: EventTarget | null): boolean {
	const el = target as { tagName?: string; isContentEditable?: boolean } | null;
	if (!el?.tagName) return false;
	return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName.toUpperCase()) || el.isContentEditable === true;
}

// A modal on screen: the STARbase dialog stand-in, any aria-modal element (the phone sheet, the
// overlay) or the finder.
export const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], .v-dialog';
