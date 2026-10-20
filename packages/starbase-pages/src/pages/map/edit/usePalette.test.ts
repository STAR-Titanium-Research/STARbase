import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { MethodEntry, TestTypeEntry } from './catalog';
import { usePalette } from './usePalette';

const methods: MethodEntry[] = [
	{ id: 'mt', name: 'CNC Turning', code: 'MC', category: 'machining' },
	{ id: 'mf', name: 'FAST/SPS Sintering', code: 'MF', category: 'sintering' },
];
const testTypes: TestTypeEntry[] = [{ value: 'tensile', name: 'Tensile' }];

const store = new Map<string, string>();
beforeEach(() => {
	store.clear();
	vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
});
afterEach(() => void vi.unstubAllGlobals());

const make = (person: { value: string | null } = { value: 'u1' }, recents: string[] = []) => ({ person, ...usePalette({ methods: () => methods, testTypes: () => testTypes, recents: ref(recents), person: () => person.value }) });

describe('the palette', () => {
	it('lists the one catalog: samples, operations by category, tests', () => {
		const p = make();
		expect(p.entries.value.map((e) => e.label)).toEqual(['New sample', 'Existing sample…', 'From database…', 'CNC Turning', 'FAST/SPS Sintering', 'Tensile']);
		expect(p.grouped.value).toBe(true);
	});

	it('narrows to what is typed, as the add search does (a code finds its method), and then is one flat list', () => {
		const p = make();
		p.query.value = 'mf';
		expect(p.entries.value.map((e) => e.label)).toEqual(['FAST/SPS Sintering']);
		expect(p.grouped.value).toBe(false);
		p.query.value = 'tens';
		expect(p.entries.value.map((e) => e.label)).toEqual(['Tensile']);
		p.query.value = '';
		expect(p.entries.value).toHaveLength(6);
	});

	it('puts what was added lately on top, as its own group', () => {
		const p = make({ value: 'u1' }, ['test:tensile']);
		expect(p.entries.value[0]).toMatchObject({ label: 'Tensile', section: 'Recent' });
		expect(p.entries.value.filter((e) => e.label === 'Tensile')).toHaveLength(1);
	});

	it('folds and unfolds, remembered per person', () => {
		const p = make();
		expect(p.folded.value).toBe(false);
		p.toggle();
		expect(p.folded.value).toBe(true);
		expect(store.get('d1.map.palette.v1.u1')).toBe('folded');
		expect(make().folded.value, 'the next visit').toBe(true);
		expect(make({ value: 'u2' }).folded.value, 'someone else').toBe(false);
		p.fold(false);
		expect(store.get('d1.map.palette.v1.u1')).toBe('open');
	});

	it('takes the person\'s own setting once they are known', async () => {
		store.set('d1.map.palette.v1.u9', 'folded');
		const person = ref<string | null>(null);
		const p = usePalette({ methods: () => methods, testTypes: () => testTypes, recents: ref([]), person: () => person.value });
		expect(p.folded.value).toBe(false);
		person.value = 'u9';
		await nextTick();
		expect(p.folded.value).toBe(true);
	});

	it('works without storage', () => {
		vi.stubGlobal('window', {
			get localStorage(): Storage {
				throw new Error('blocked');
			},
		});
		const p = make();
		expect(p.folded.value).toBe(false);
		p.toggle();
		expect(p.folded.value).toBe(true);
	});
});
