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
