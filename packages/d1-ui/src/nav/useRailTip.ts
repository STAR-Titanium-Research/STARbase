import { onBeforeUnmount, ref } from 'vue';

// The rail's tooltip pill: one shared element, placed with position: fixed beside the icon that is
// hovered or keyboard-focused, so a rail that scrolls (a short window) never clips it. The icon's own
// aria-label is what assistive technology reads; the pill is visual only.
export interface RailTip {
	text: string;
	kbd?: string;
	top: number;
	left: number;
}

export function useRailTip() {
	const tip = ref<RailTip | null>(null);

	function show(el: HTMLElement, text: string, kbd?: string) {
		const icon = el.querySelector<HTMLElement>('.icon') ?? el;
		const r = icon.getBoundingClientRect();
		tip.value = { text, kbd, top: r.top + r.height / 2, left: r.right + 8 };
	}
	const hide = () => {
		tip.value = null;
	};

	// The handlers a slot takes; one set per label.
	function tipEvents(text: string, kbd?: string) {
		return {
			pointerenter: (e: PointerEvent) => {
				if (e.pointerType === 'mouse') show(e.currentTarget as HTMLElement, text, kbd);
			},
			pointerleave: hide,
			focusin: (e: FocusEvent) => {
				if ((e.target as HTMLElement).matches?.(':focus-visible')) show(e.currentTarget as HTMLElement, text, kbd);
			},
			focusout: hide,
			click: hide,
		};
	}

	// A scroll of the rail (or the page) moves the icon from under the pill.
	window.addEventListener('scroll', hide, true);
	onBeforeUnmount(() => window.removeEventListener('scroll', hide, true));

	return { tip, tipEvents };
}
