import { describe, expect, it } from 'vitest';
import type { DraftBody, DraftOperation } from '@d1/ui';
import type { MethodEntry, TestTypeEntry } from './catalog';
import { apply, emptyBody, itemOf, type DraftAction } from './draft';
import { actionsFor, canvasSampleEntries, filterEntries, firstChoosable, menuFor, moveActive, placeMenu, rootEntries, sampleLabel, type MenuCatalog, type MenuChoice, type MenuEntry, type TemplateEntry } from './menuModel';
import type { SocketRef } from './socketRefs';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

const methods: MethodEntry[] = [
	{ id: 'mt', name: 'Turning', code: 'MC', category: 'machining' },
	{ id: 'mm', name: 'Milling', code: 'MM', category: 'machining' },
	{ id: 'mf', name: 'FAST sintering', code: 'MF', category: 'sintering' },
	{ id: 'mx', name: 'Mystery', code: 'MX', category: null },
];
const testTypes: TestTypeEntry[] = [{ value: 'tensile', name: 'Tensile' }, { value: 'xrd', name: 'XRD' }];
const catalog: MenuCatalog = { methods, testTypes };

const tpl = (over: Partial<TemplateEntry> = {}): TemplateEntry => ({ id: 't1', name: 'Rough turn', collection: 'manufacturing_operations', values: { method_id: 'mt', feed_rate: 0.2 }, ...over });
const sock = (kind: 'sample' | 'row', id: string, side: 'in' | 'out'): SocketRef => ({ kind, id, side });

/** n1 a sample, n2 a blank operation (row n3) fed by it, n4 a test, n5 another sample. */
const body = (): DraftBody =>
	run([
		{ type: 'addSample' },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mt' }, from: { key: 'n1' } },
		{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' } },
		{ type: 'addSample' },
	]);

const labels = (es: MenuEntry[]) => es.map((e) => e.label);
const sections = (es: MenuEntry[]) => [...new Set(es.map((e) => e.section))];

describe('what the menu is for', () => {
	it('knows the kind of card a socket is on', () => {
		const b = body();
		expect(menuFor(b, null)).toEqual({ side: null, card: null, end: null });
		expect(menuFor(b, sock('sample', 'draft:n1', 'out'))).toEqual({ side: 'out', card: 'sample', end: { key: 'n1' } });
		expect(menuFor(b, sock('row', 'draft:n3', 'out'))).toEqual({ side: 'out', card: 'operation', end: { key: 'n2', row: 0 } });
		expect(menuFor(b, sock('row', 'draft:n4', 'in'))).toEqual({ side: 'in', card: 'test', end: { key: 'n4' } });
	});

	it('counts a sample of the loaded history as a sample card, with no end until the draft holds it', () => {
		expect(menuFor(body(), sock('sample', 'old', 'out'))).toEqual({ side: 'out', card: 'sample', end: null });
	});
});

describe('the entries', () => {
	it('from a sample output: templates, operations by category (the lab\'s order, no category last), then the tests', () => {
		const b = body();
		const es = rootEntries(b, menuFor(b, sock('sample', 'draft:n1', 'out')), { ...catalog, templates: [tpl()] });
		expect(sections(es)).toEqual(['Templates', 'Machining', 'FAST sintering', 'Other methods', 'Tests', 'Wire']);
		expect(labels(es)).toEqual(['Rough turn', 'Turning', 'Milling', 'FAST sintering', 'Mystery', 'Tensile', 'XRD', 'Connect to…']);
		expect(es.find((e) => e.label === 'Turning')?.detail).toBe('MC');
	});

	it('unconnected: the same, and the samples', () => {
		const es = rootEntries(body(), menuFor(body(), null), catalog);
		expect(sections(es)).toEqual(['Machining', 'FAST sintering', 'Other methods', 'Tests', 'Samples']);
		expect(labels(es).slice(-2)).toEqual(['New sample', 'Pick samples…']);
	});

	it('from an operation output: New sample, Same sample, Existing sample…', () => {
		const b = body();
		const es = rootEntries(b, menuFor(b, sock('row', 'draft:n3', 'out')), catalog);
		expect(labels(es)).toEqual(['New sample', 'Same sample', 'Existing sample…', 'Connect to…']);
		expect(es[1].disabled).toBeUndefined(); // the sample n1 feeds it
	});

	it('Same sample is greyed, with the reason, while nothing feeds the operation', () => {
		const b = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		const es = rootEntries(b, menuFor(b, sock('row', 'draft:n2', 'out')), catalog);
		expect(es.find((e) => e.label === 'Same sample')?.disabled).toBe('Wire a sample into this operation first.');
	});

	it('a test has no output to build from', () => {
		const b = body();
		expect(rootEntries(b, menuFor(b, sock('row', 'draft:n4', 'out')), catalog)).toEqual([]);
	});

	it('from a free input of an operation or a test: New sample, Existing sample…', () => {
		const b = body();
		for (const id of ['draft:n3', 'draft:n4']) {
			expect(labels(rootEntries(b, menuFor(b, sock('row', id, 'in')), catalog))).toEqual(['New sample', 'Existing sample…', 'Connect to…']);
		}
	});

	it('from a sample\'s input: the operations that could make it, no tests', () => {
		const b = body();
		const es = rootEntries(b, menuFor(b, sock('sample', 'draft:n5', 'in')), catalog);
		expect(sections(es)).toEqual(['Machining', 'FAST sintering', 'Other methods', 'Wire']);
	});

	it('lists a template that cannot be used greyed, with its reason', () => {
		const es = rootEntries(body(), menuFor(body(), null), { ...catalog, templates: [tpl({ disabled: 'Its tool is retired.' })] });
		expect(es[0]).toMatchObject({ section: 'Templates', label: 'Rough turn', detail: 'Operation', disabled: 'Its tool is retired.' });
	});

	it('lists the samples on the canvas an output could go to, the others greyed with the draft\'s reason', () => {
		const b = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }, { type: 'addSample' }, { type: 'addExistingSamples', samples: [{ id: 'old', version: 2 }] }]);
		const es = canvasSampleEntries(b, { key: 'n2', row: 0 }, (key) => `card ${key}`);
		expect(es.map((e) => [e.label, e.disabled ?? 'ok'])).toEqual([
			['card n1', 'ok'], // the sample it took in: in place
			['card n4', 'ok'],
			['card n5', 'That sample already exists with its own history: it cannot be made by this operation.'],
		]);
		expect(es[0].choice).toEqual({ kind: 'wireSample', key: 'n1' });
	});
});

describe('narrowing the list', () => {
	const es = rootEntries(body(), menuFor(body(), null), catalog);

	it('keeps the entries that have every word, in the label, the detail or the section', () => {
		expect(labels(filterEntries(es, 'mill'))).toEqual(['Milling']);
		expect(labels(filterEntries(es, 'MF'))).toEqual(['FAST sintering']);
		expect(labels(filterEntries(es, 'machining'))).toEqual(['Turning', 'Milling']);
		expect(labels(filterEntries(es, 'tests ten'))).toEqual(['Tensile']);
		expect(filterEntries(es, 'zzz')).toEqual([]);
		expect(filterEntries(es, '  ')).toHaveLength(es.length);
	});
});

describe('moving through the list', () => {
	const list = (disabled: boolean[]): MenuEntry[] => disabled.map((d, i) => ({ id: String(i), section: 's', label: String(i), choice: { kind: 'newSample' }, ...(d ? { disabled: 'no' } : {}) }));

	it('steps over what cannot be chosen, and wraps', () => {
		const es = list([false, true, false]);
		expect(moveActive(es, 0, 1)).toBe(2);
		expect(moveActive(es, 2, 1)).toBe(0);
		expect(moveActive(es, 0, -1)).toBe(2);
		expect(moveActive(es, -1, 1)).toBe(0);
		expect(moveActive(es, -1, -1)).toBe(2);
	});

	it('finds nothing when nothing can be chosen, or the list is empty', () => {
		expect(moveActive(list([true, true]), 0, 1)).toBe(-1);
		expect(moveActive([], -1, 1)).toBe(-1);
		expect(firstChoosable(list([true, false]))).toBe(1);
		expect(firstChoosable(list([true]))).toBe(-1);
	});
});

describe('keeping the menu in the window', () => {
	const view = { width: 1000, height: 700 };
	it('stays where it opened when it fits', () => expect(placeMenu({ x: 100, y: 120 }, { width: 300, height: 200 }, view)).toEqual({ left: 100, top: 120 }));
	it('moves left and up from the right and bottom edges', () => expect(placeMenu({ x: 900, y: 650 }, { width: 300, height: 200 }, view)).toEqual({ left: 692, top: 492 }));
	it('never goes off the top or left', () => expect(placeMenu({ x: -20, y: -5 }, { width: 300, height: 200 }, view)).toEqual({ left: 8, top: 8 }));
	it('keeps a menu taller than the window at the top', () => expect(placeMenu({ x: 10, y: 300 }, { width: 300, height: 900 }, view).top).toBe(8));
});

describe('what a choice does', () => {
	const at = { x: 40, y: 60 };
	const target = (b: DraftBody, s: SocketRef | null, over: { at?: typeof at } = {}) => {
		const f = menuFor(b, s);
		return { body: b, end: f.end, side: f.side, card: f.card, at: over.at };
	};
	const doIt = (b: DraftBody, s: SocketRef | null, choice: MenuChoice, over: { at?: typeof at } = {}) => run(actionsFor(target(b, s, over), choice), b);

	it('a method from a sample output makes an operation of that method and category, wired from the sample', () => {
		const b = doIt(body(), sock('sample', 'draft:n5', 'out'), { kind: 'operation', methodId: 'mm', category: 'machining' }, { at });
		const made = b.items.at(-1) as DraftOperation;
		expect(made).toMatchObject({ kind: 'operation', workState: 'planned', values: { method_id: 'mm', process_category: 'machining' } });
		expect(b.wires.at(-1)).toEqual({ from: { key: 'n5' }, to: { key: made.key, row: 0 } });
		expect(b.positions[made.key]).toEqual(at);
	});

	it('a method with no category sets no category', () => {
		const b = doIt(body(), null, { kind: 'operation', methodId: 'mx', category: null });
		expect((b.items.at(-1) as DraftOperation).values).toEqual({ method_id: 'mx' });
	});

	it('a method from a free sample input makes the operation and wires its output row to that sample', () => {
		const b = doIt(body(), sock('sample', 'draft:n5', 'in'), { kind: 'operation', methodId: 'mt', category: 'machining' });
		const made = b.items.at(-1) as DraftOperation;
		expect(b.wires.at(-1)).toEqual({ from: { key: made.key, row: 0 }, to: { key: 'n5' } });
	});

	it('a test type from a sample output makes a test of that type, wired from the sample; a test cannot feed a sample\'s input', () => {
		const b = doIt(body(), sock('sample', 'draft:n5', 'out'), { kind: 'test', testType: 'xrd' });
		expect(b.items.at(-1)).toMatchObject({ kind: 'test', values: { test_type: 'xrd' } });
		expect(b.wires.at(-1)?.from).toEqual({ key: 'n5' });
		const before = body();
		expect(actionsFor(target(before, sock('sample', 'draft:n5', 'in')), { kind: 'test', testType: 'xrd' })).toEqual([]);
	});

	it('a template makes a container with its saved values', () => {
		const b = doIt(body(), null, { kind: 'template', template: tpl() });
		expect(b.items.at(-1)).toMatchObject({ kind: 'operation', values: { method_id: 'mt', feed_rate: 0.2 } });
		const t = doIt(body(), null, { kind: 'template', template: tpl({ collection: 'test_sessions', values: { test_type: 'xrd' } }) });
		expect(t.items.at(-1)).toMatchObject({ kind: 'test', values: { test_type: 'xrd' } });
	});

	it('New sample unconnected is a blank card at the point; from an operation output it is what the operation makes', () => {
		const b = doIt(body(), null, { kind: 'newSample' }, { at });
		expect(b.items.at(-1)).toMatchObject({ kind: 'sample', key: 'n6' });
		expect(b.positions.n6).toEqual(at);
		const made = doIt(body(), sock('row', 'draft:n3', 'out'), { kind: 'newSample' });
		expect(made.wires.at(-1)).toEqual({ from: { key: 'n2', row: 0 }, to: { key: 'n6' } });
	});

	it('New sample on a free input is a sample that feeds it (a test too)', () => {
		const t = doIt(body(), sock('row', 'draft:n4', 'in'), { kind: 'newSample' });
		expect(t.wires.at(-1)).toEqual({ from: { key: 'n6' }, to: { key: 'n4' } });
		const free = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		const o = doIt(free, sock('row', 'draft:n2', 'in'), { kind: 'newSample' });
		expect(o.wires.at(-1)).toEqual({ from: { key: 'n3' }, to: { key: 'n1', row: 0 } });
	});

	it('Same sample wires the operation\'s output back to the sample it took in (in place)', () => {
		const b = doIt(body(), sock('row', 'draft:n3', 'out'), { kind: 'sameSample' });
		expect(b.wires.at(-1)).toEqual({ from: { key: 'n2', row: 0 }, to: { key: 'n1' } });
		expect(itemOf(b, 'n2')).toBeDefined();
		// with nothing feeding the operation there is nothing to carry on
		const free = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		expect(actionsFor(target(free, sock('row', 'draft:n2', 'out')), { kind: 'sameSample' })).toEqual([]);
	});

	it('a sample of the draft is wired to the socket, from whichever side the menu was opened on', () => {
		const out = doIt(body(), sock('row', 'draft:n3', 'out'), { kind: 'wireSample', key: 'n5' });
		expect(out.wires.at(-1)).toEqual({ from: { key: 'n2', row: 0 }, to: { key: 'n5' } });
		const free = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		const inn = doIt(free, sock('row', 'draft:n3', 'in'), { kind: 'wireSample', key: 'n1' });
		expect(inn.wires.at(-1)).toEqual({ from: { key: 'n1' }, to: { key: 'n2', row: 0 } });
	});

	it('does nothing for a choice that does not fit, or that is not an action (picking samples, searching)', () => {
		const b = body();
		expect(actionsFor(target(b, sock('sample', 'draft:n1', 'out')), { kind: 'newSample' })).toEqual([]);
		expect(actionsFor(target(b, sock('row', 'draft:n3', 'out')), { kind: 'operation', methodId: 'mt', category: null })).toEqual([]);
		expect(actionsFor(target(b, null), { kind: 'pickSamples' })).toEqual([]);
		expect(actionsFor(target(b, null), { kind: 'existingSample' })).toEqual([]);
		expect(actionsFor(target(b, sock('sample', 'draft:n1', 'out')), { kind: 'connectTo' })).toEqual([]);
		expect(actionsFor(target(b, sock('row', 'draft:n3', 'in')), { kind: 'wireSample', key: 'nope' })).toEqual([]);
		expect(actionsFor(target(b, sock('row', 'draft:n3', 'in')), { kind: 'record', id: 'x', code: 'X' })).toEqual([]);
	});

	it('is one undoable step for a choice that is two actions', () => {
		const actions = actionsFor(target(body(), sock('row', 'draft:n4', 'in')), { kind: 'newSample' });
		expect(actions).toHaveLength(2);
	});
});

describe('names in menus', () => {
	it('a new sample is called by what its code will be, an existing one by its code', () => {
		const b = run([{ type: 'addSample', values: { sample_code: '{seq}-Ti64-MC-2026-10-15' } }, { type: 'addSample' }, { type: 'addExistingSamples', samples: [{ id: 'old', version: 1 }] }]);
		const known = (id: string) => (id === 'old' ? 'PS-001' : undefined);
		expect(sampleLabel(b, 'n1', known)).toBe('New sample Ti64-MC-2026-10-15');
		expect(sampleLabel(b, 'n2', known)).toBe('New sample');
		expect(sampleLabel(b, 'n3', known)).toBe('PS-001');
		expect(sampleLabel(b, 'zz', known)).toBe('zz');
	});
});
