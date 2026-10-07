import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import { perKeyComputed } from './perKeyComputed';

describe('perKeyComputed', () => {
	it('rebuilds only when something it read changed, and returns the same object otherwise', () => {
		const channels = ref(3);
		const hover = ref<number | null>(null);   // read by the "render", not by build
		let builds = 0;
		const get = perKeyComputed((p: { i: string }) => p.i, () => { builds++; return { n: channels.value }; });
		const panel = { i: 'a' };
		// a render reads hover too, as the dashboard's template does
		const render = () => { void hover.value; return get(panel); };
		const first = render();
		for (let k = 0; k < 50; k++) { hover.value = k; expect(render()).toBe(first); }
		expect(builds).toBe(1);
		channels.value = 4;
		const second = render();
		expect(second).not.toBe(first);
		expect(second.n).toBe(4);
		expect(builds).toBe(2);
	});

	it('keeps one entry per key', () => {
		let builds = 0;
		const get = perKeyComputed((p: { i: string }) => p.i, (p) => { builds++; return p.i; });
		const a = { i: 'a' }, b = { i: 'b' };
		expect([get(a), get(b), get(a), get(b)]).toEqual(['a', 'b', 'a', 'b']);
		expect(builds).toBe(2);
	});

	it('does not serve a replaced panel object from the old one', () => {
		const get = perKeyComputed((p: { i: string; v: number }) => p.i, (p) => p.v);
		expect(get({ i: 'a', v: 1 })).toBe(1);
		expect(get({ i: 'a', v: 2 })).toBe(2);
	});

	it('is safe to use with a plain computed dependency', () => {
		const x = ref(1);
		const doubled = computed(() => x.value * 2);
		const get = perKeyComputed((p: { i: string }) => p.i, () => doubled.value);
		const p = { i: 'k' };
		expect(get(p)).toBe(2);
		x.value = 5;
		expect(get(p)).toBe(10);
	});
});
