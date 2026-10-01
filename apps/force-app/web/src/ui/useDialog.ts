// Keyboard behaviour shared by the app's modal dialogs — what ConfirmDialog already did on its
// own, and none of the others did: focus moves into the dialog when it opens (its [autofocus]
// field, else the panel), Tab stays inside it, Escape dismisses it where dismissing is allowed,
// and focus goes back to whatever had it on close. Before this, focus stayed on the page behind
// the backdrop, so Tab walked the controls the dialog was covering.
//
// Driven by the panel ref, not the component lifecycle, so it also serves a dialog rendered with
// v-if inside a page (NidaqPage's card catalog): it arms when the element appears and disarms
// when it goes.
import { onBeforeUnmount, watch, type Ref } from 'vue';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function useDialog(panel: Ref<HTMLElement | null>, onEscape?: () => void) {
	let restoreTo: HTMLElement | null = null;
	let armed = false;

	function onKeydown(e: KeyboardEvent) {
		const el = panel.value;
		// defaultPrevented: the confirm prompt stacked on top (capture-phase listener) handled it.
		if (!el || e.defaultPrevented) return;
		if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); return; }
		if (e.key !== 'Tab') return;
		const active = document.activeElement;
		const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
		if (!items.length) { e.preventDefault(); return; }
		const first = items[0];
		const last = items[items.length - 1];
		if (!active || !el.contains(active)) {
			// Inside another dialog stacked on top: that one traps its own Tab.
			if (active?.closest('[role="dialog"], [role="alertdialog"]')) return;
			// Otherwise focus has fallen out (e.g. a lookup's Escape blurred its input to <body>):
			// bring it back in rather than letting Tab walk the page behind the backdrop.
			e.preventDefault();
			(e.shiftKey ? last : first).focus();
			return;
		}
		if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
	}

	function arm(el: HTMLElement) {
		if (armed) return;
		armed = true;
		restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		window.addEventListener('keydown', onKeydown);
		(el.querySelector<HTMLElement>('[autofocus]') ?? el).focus({ preventScroll: true });
	}
	function disarm() {
		if (!armed) return;
		armed = false;
		window.removeEventListener('keydown', onKeydown);
		if (restoreTo?.isConnected) restoreTo.focus({ preventScroll: true });
		restoreTo = null;
	}

	watch(panel, (el) => (el ? arm(el) : disarm()), { flush: 'post', immediate: true });
	onBeforeUnmount(disarm);
}
