// @vitest-environment happy-dom
// useInView watches inside the nearest scrolling ancestor (Data Studio scrolls #main-content, not the window), and falls back to the viewport.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { scrollParentOf, useInView } from './usePicture';

const made: Array<{ options: IntersectionObserverInit | undefined; observed: Element[] }> = [];
class FakeIO {
	rec: (typeof made)[number];
	constructor(_cb: unknown, options?: IntersectionObserverInit) {
		this.rec = { options, observed: [] };
		made.push(this.rec);
	}
	observe(el: Element) {
		this.rec.observed.push(el);
	}
	unobserve() {}
	disconnect() {}
}

let app: App | null = null;
beforeEach(() => {
	document.body.innerHTML = '';
	made.length = 0;
	vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
	app?.unmount();
	app = null;
	vi.unstubAllGlobals();
});

function nest(overflow: string | null) {
	const outer = document.createElement('div');
	if (overflow) outer.style.overflowY = overflow;
	const inner = document.createElement('div');
	const target = document.createElement('button');
	inner.appendChild(target);
	outer.appendChild(inner);
	document.body.appendChild(outer);
	return { outer, target };
}

describe('scrollParentOf', () => {
	it('is the nearest ancestor with overflow auto, scroll or overlay', () => {
		for (const v of ['auto', 'scroll', 'overlay']) {
			document.body.innerHTML = '';
			const { outer, target } = nest(v);
			expect(scrollParentOf(target)).toBe(outer);
		}
	});
	it('is null when only the page scrolls', () => {
		const { target } = nest(null);
		expect(scrollParentOf(target)).toBeNull();
		expect(scrollParentOf(document.body)).toBeNull();
	});
});

describe('useInView', () => {
	function mountWith(target: HTMLElement) {
		const el = ref<HTMLElement | null>(target);
		app = createApp(
			defineComponent({
				setup() {
					useInView(el);
					return () => h('i');
				},
			}),
		);
		app.mount(document.createElement('div'));
	}

	it('observes inside the scrolling container, with the look-ahead as its margin', async () => {
		const { outer, target } = nest('auto');
		mountWith(target);
		await vi.waitFor(() => expect(made[0]?.observed).toEqual([target]));
		expect(made[0].options).toMatchObject({ root: outer, rootMargin: '200px' });
	});

	it('uses the viewport (no root) when nothing above it scrolls', async () => {
		const { target } = nest(null);
		mountWith(target);
		await vi.waitFor(() => expect(made[0]?.observed).toEqual([target]));
		expect(made[0].options?.root).toBeUndefined();
		expect(made[0].options).toMatchObject({ rootMargin: '200px' });
	});

	it('falls back to the viewport when the browser refuses the root', async () => {
		const Real = FakeIO;
		vi.stubGlobal(
			'IntersectionObserver',
			class extends Real {
				constructor(cb: unknown, options?: IntersectionObserverInit) {
					if (options?.root) throw new TypeError('bad root');
					super(cb, options);
				}
			},
		);
		const { target } = nest('scroll');
		mountWith(target);
		await vi.waitFor(() => expect(made[0]?.observed).toEqual([target]));
		expect(made[0].options?.root).toBeUndefined();
	});
});
