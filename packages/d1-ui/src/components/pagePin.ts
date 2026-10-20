import { inject, provide, ref } from 'vue';
import type { Ref } from 'vue';
import type { PinRef } from '../nav/sidebarModel';

// What the page's header pins, handed from the page to its frame. The Pin button sits right after the
// page title (DESIGN.md "Pin on the title"), and the title belongs to the host's frame (STARbase's
// PlainFrame), not to the page. So a page that can be pinned calls providePagePin() with its target
// (pinTargetForIndex / pinTargetForRecord), and the frame calls usePagePin() to draw the button.
// A page with nothing to pin provides nothing, or a ref that holds null: no button.

const KEY = Symbol('d1-page-pin');
const NOTHING = ref<PinRef | null>(null);

/** Called in a page's setup. The target may change (a saved view opens), so it is a ref. */
export function providePagePin(target: Ref<PinRef | null>): void {
	provide(KEY, target);
}

/** Called by the frame: the target the page provided, or a ref holding null when no page did. */
export function usePagePin(): Ref<PinRef | null> {
	return inject<Ref<PinRef | null>>(KEY, NOTHING);
}
