// The person panel's narrow layout: below the wide breakpoint it is a full-height sheet over the page, as STARbase's phone menu is
// (apps/starbase/web AppShell.vue). The shell's own helpers (backdropDismiss.ts, sheetFocus.ts, narrow.ts) are the app's, and a page
// package cannot import them (it also runs in the Directus host), so the small pure parts are restated here and unit-tested.
import { getCurrentInstance, onBeforeUnmount, ref, type Ref } from 'vue';

/** Wide: the panel sits beside the list. Keep in step with the `min-width` in PeopleView.vue's styles. */
export const WIDE_QUERY = '(min-width: 1000px)';

type Query = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

function systemQuery(): Query | null {
	try {
		return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null;
	} catch {
		return null;
	}
}

/** True while the window is narrower than the wide layout (so the panel is a sheet), followed live (a rotated phone). */
export function useNarrowPanel(mq: Query | null = systemQuery()): Ref<boolean> {
	const narrow = ref(mq ? !mq.matches : false);
	if (!mq) return narrow;
	const onChange = (e: { matches: boolean }) => (narrow.value = !e.matches);
	mq.addEventListener('change', onChange);
	if (getCurrentInstance()) onBeforeUnmount(() => mq.removeEventListener('change', onChange));
	return narrow;
}

/**
 * The backdrop closes the sheet only for a real tap on it: the press must have STARTED on the backdrop (not inside the sheet) and the
 * click must END on it, or pressing inside the sheet and releasing outside it would dismiss it.
 */
export const backdropDismiss = (startedOnBackdrop: boolean, endedOnBackdrop: boolean): boolean => startedOnBackdrop && endedOnBackdrop;

/**
 * Tab wraps inside the sheet: from the last control forward it goes to the first, from the first (or the sheet itself) backward to the
 * last. Returns the index to focus, or null when the browser should move focus as usual.
 */
export function tabWrapTarget(count: number, activeIndex: number, shift: boolean): number | null {
	if (count === 0) return null;
	// activeIndex -1: focus is on the sheet itself (it takes focus when it opens)
	if (shift) return activeIndex <= 0 ? count - 1 : null;
	return activeIndex === count - 1 ? 0 : null;
}
