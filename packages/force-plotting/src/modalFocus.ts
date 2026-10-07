// Keyboard behaviour shared by the modal dialogs (PlotHelp, RecipeDialog, the web app's
// DiagBatchDialog): Escape calls `onEscape`, Tab stays inside `rootEl`, `initialFocus` runs once
// mounted, and focus goes back to whatever opened the dialog when it closes.
import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue';

const FOCUSABLE =
	'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(
	rootEl: Ref<HTMLElement | null>,
	opts: { onEscape: () => void; initialFocus: () => void },
) {
	let opener: HTMLElement | null = null;

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); opts.onEscape(); return; }
		if (e.key !== 'Tab' || !rootEl.value) return;
		const els = Array.from(rootEl.value.querySelectorAll<HTMLElement>(FOCUSABLE));
		if (!els.length) return;
		const first = els[0], last = els[els.length - 1];
		const cur = document.activeElement;
		if (!rootEl.value.contains(cur)) { e.preventDefault(); first.focus(); }
		else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
	}
	onMounted(() => {
		opener = document.activeElement as HTMLElement | null;
		window.addEventListener('keydown', onKey, true);
		nextTick(opts.initialFocus);
	});
	onBeforeUnmount(() => {
		window.removeEventListener('keydown', onKey, true);
		opener?.focus?.();
	});
}
