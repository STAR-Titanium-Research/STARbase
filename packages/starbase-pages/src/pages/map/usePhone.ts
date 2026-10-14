import { getCurrentInstance, onBeforeUnmount, ref, type Ref } from 'vue';

// STARbase's phone layout starts below 768 px (spec D24; the shell's own query is apps/starbase/web
// narrow.ts, which a page package cannot import). Live: rotating a phone switches layouts.
export const PHONE_QUERY = '(max-width: 767px)';

type Query = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

function systemQuery(): Query | null {
	try {
		return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null;
	} catch {
		return null;
	}
}

export function useIsPhone(mq: Query | null = systemQuery()): Ref<boolean> {
	const phone = ref(mq?.matches ?? false);
	if (!mq) return phone;
	const onChange = (e: { matches: boolean }) => (phone.value = e.matches);
	mq.addEventListener('change', onChange);
	if (getCurrentInstance()) onBeforeUnmount(() => mq.removeEventListener('change', onChange));
	return phone;
}

/**
 * Where Vue Flow's zoom controls sit. Bottom-left on a desktop; on a phone the bottom band of the window is the
 * collapsed bottom sheet (MapSheet), which at first paint lies over the canvas's lower corner, so the controls go
 * to the top-left, where nothing covers them.
 */
export const controlsPosition = (phone: boolean): 'top-left' | 'bottom-left' => (phone ? 'top-left' : 'bottom-left');
