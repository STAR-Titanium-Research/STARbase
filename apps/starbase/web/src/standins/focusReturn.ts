import { nextTick, onBeforeUnmount, watch } from 'vue';
import { restoreFocus } from './dialogStack';

// Remember what had focus when a dialog opens and give it back when the dialog closes, whichever way
// (Esc, a button, the parent unmounting it). Skipped when the opener has left the page.
export function useFocusReturn(isOpen: () => boolean): void {
	if (typeof document === 'undefined') return;
	let opener: HTMLElement | null = null;
	const giveBack = async () => {
		const el = opener;
		opener = null;
		if (!el) return;
		await nextTick(); // after the dialog's own DOM has gone
		restoreFocus(el);
	};
	watch(
		isOpen,
		(open) => {
			if (open) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			else void giveBack();
		},
		{ immediate: true },
	);
	onBeforeUnmount(() => void giveBack());
}
