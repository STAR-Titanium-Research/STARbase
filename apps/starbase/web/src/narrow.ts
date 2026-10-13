import { onBeforeUnmount, ref, type Ref } from 'vue';

// STARbase's phone layout starts below 768 px (spec §3.3). One query for the shell, the plot note and
// the e2e, matched live (rotating a phone or resizing a window switches layouts).
export const PHONE_MAX_WIDTH = 767;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

export function isPhoneWidth(width: number): boolean {
	return width <= PHONE_MAX_WIDTH;
}

export function useNarrow(): Ref<boolean> {
	const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null;
	const narrow = ref(mq?.matches ?? false);
	const onChange = (e: MediaQueryListEvent) => (narrow.value = e.matches);
	mq?.addEventListener('change', onChange);
	onBeforeUnmount(() => mq?.removeEventListener('change', onChange));
	return narrow;
}
