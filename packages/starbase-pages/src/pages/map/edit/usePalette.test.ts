import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { MethodEntry, TestTypeEntry } from './catalog';
import type { TemplateItem } from './templates';
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
	it('lists the kinds with nothing typed: Sample, Operation, Test, From database…, and no method or test type', () => {
		const p = make();
		expect(p.entries.value.map((e) => e.id)).toEqual(['kind:sample', 'kind:operation', 'kind:test', 'db:attach']);
		expect(p.entries.value.some((e) => e.id.startsWith('op:') || e.id.startsWith('test:'))).toBe(false);
		expect(p.grouped.value).toBe(true);
	});

	it('searches the whole catalog when something is typed (a method by name or code, a test type), as one flat list', () => {
		const p = make();
		p.query.value = 'turn';
		expect(p.entries.value.map((e) => e.id)).toEqual(['op:mt']);
		p.query.value = 'mf';
		expect(p.entries.value.map((e) => e.label)).toEqual(['FAST/SPS Sintering']);
		expect(p.grouped.value).toBe(false);
		p.query.value = 'tens';
		expect(p.entries.value.map((e) => e.label)).toEqual(['Tensile']);
		p.query.value = '';
		expect(p.entries.value).toHaveLength(4);
	});

	it('puts what was added lately after the kinds, as its own group', () => {
		const p = make({ value: 'u1' }, ['test:tensile']);
		expect(p.entries.value.map((e) => e.id)).toEqual(['kind:sample', 'kind:operation', 'kind:test', 'db:attach', 'test:tensile']);
		expect(p.entries.value[4]).toMatchObject({ label: 'Tensile', section: 'Recent' });
	});

	it('does not list "New sample" as a recent: the Sample kind is that', () => {
		const p = make({ value: 'u1' }, ['sample:new']);
		expect(p.entries.value.map((e) => e.id)).toEqual(['kind:sample', 'kind:operation', 'kind:test', 'db:attach']);
	});

	it('lists the templates after the kinds, before the recents', () => {
		const tpl: TemplateItem = { rec: { id: 't1', name: 'Roughing pass', scope: 'private', role_id: null, collection: 'manufacturing_operations', values: { method_id: 'mt' }, user_id: 'u1', updated_at: 'now', version: 1 }, mine: true };
		const p = usePalette({ methods: () => methods, testTypes: () => testTypes, templates: () => [tpl], recents: ref(['test:tensile']), person: () => 'u1' });
		expect(p.entries.value.map((e) => e.id)).toEqual(['kind:sample', 'kind:operation', 'kind:test', 'db:attach', 'tpl:t1', 'test:tensile']);
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
