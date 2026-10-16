import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import type { HostApi } from '@d1/ui';
import type { PictureSize } from './inboxApi';
import { picturesFor, type PictureHandle } from './inboxPictures';

// The Vue side of the Inbox pictures (inboxPictures.ts holds the cache and the queue).

export type PictureState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * One picture of one file for as long as the component lives: it asks the shared store when `id` is set and `active` is true (a row asks once
 * it has scrolled into view), shows `url` when it is in, `state` 'failed' when it is not, and lets go of it (which revokes the object URL) when `id`
 * changes or the component unmounts. `retry` asks again after a failure.
 */
export function usePicture(api: HostApi, id: () => string | null, size: PictureSize, active: () => boolean, opts: { priority?: boolean } = {}) {
	const state = ref<PictureState>('idle');
	const url = ref<string | null>(null);
	let handle: PictureHandle | null = null;

	function stop(): void {
		const h = handle;
		handle = null;
		url.value = null;
		state.value = 'idle';
		h?.release();
	}
	function start(): void {
		stop();
		const candidate = id();
		if (!candidate || !active()) return;
		const h = picturesFor(api).acquire(candidate, size, { priority: opts.priority });
		handle = h;
		state.value = 'loading';
		h.promise.then(
			(u) => {
				if (handle !== h) return;
				url.value = u;
				state.value = 'ready';
			},
			() => {
				if (handle === h) state.value = 'failed';
			},
		);
	}

	watch([id, active], start, { immediate: true });
	onBeforeUnmount(stop);
	return { state, url, retry: start };
}

/**
 * Whether the element has come into view (or is about to: `margin` ahead of the viewport), and stays true from then on. Without
 * IntersectionObserver (an old browser, a test environment) it is true at once, so the picture loads rather than never.
 */
export function useInView(el: Ref<HTMLElement | null>, margin = '200px'): Ref<boolean> {
	const seen = ref(false);
	let io: IntersectionObserver | null = null;
	onMounted(() => {
		if (typeof IntersectionObserver !== 'function') {
			seen.value = true;
			return;
		}
		try {
			io = new IntersectionObserver(
				(entries) => {
					if (!entries.some((e) => e.isIntersecting)) return;
					seen.value = true;
					io?.disconnect();
				},
				{ rootMargin: margin },
			);
		} catch {
			seen.value = true;
			return;
		}
		watch(
			el,
			(now, before) => {
				if (before) io?.unobserve(before);
				if (now && !seen.value) io?.observe(now);
			},
			{ immediate: true, flush: 'post' },
		);
	});
	onBeforeUnmount(() => io?.disconnect());
	return seen;
}
