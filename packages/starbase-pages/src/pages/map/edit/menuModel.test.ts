import { describe, expect, it } from 'vitest';
import type { DraftBody, DraftOperation } from '@d1/ui';
import type { MethodEntry, TestTypeEntry } from './catalog';
import { apply, emptyBody, itemOf, type DraftAction } from './draft';
import { grown } from './socketRefs';
import { recentIdOf } from './recents';
import { actionsFor, canvasSampleEntries, catalogEntries, firstChoosable, menuFor, moveActive, operationOnlyEntries, placeMenu, rootEntries, sampleLabel, searchEntries, type MenuCatalog, type MenuChoice, type MenuEntry } from './menuModel';
import type { SocketRef } from './socketRefs';
import { templateEntries, type TemplateItem } from './templates';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

const methods: MethodEntry[] = [
	{ id: 'mt', name: 'Turning', code: 'MC', category: 'machining' },
	{ id: 'mm', name: 'Milling', code: 'MM', category: 'machining' },
	{ id: 'mf', name: 'FAST sintering', code: 'MF', category: 'sintering' },
	{ id: 'mx', name: 'Mystery', code: 'MX', category: null },
];
const testTypes: TestTypeEntry[] = [{ value: 'tensile', name: 'Tensile' }, { value: 'xrd', name: 'XRD' }];
const catalog: MenuCatalog = { methods, testTypes };

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

	it('reads a free socket that adds a row as the draft with the row: its end is the new row, which shares the input', () => {
		const b = body();
		const f = menuFor(b, { kind: 'row', id: 'draft:n3', side: 'out', add: true });
		expect(f).toEqual({ side: 'out', card: 'operation', end: { key: 'n2', row: 1 } });
		// The entries are asked about that draft: "Same sample" is on (the new row has the input), where for a row with none it is greyed.
		const grownBody = grown(b, { kind: 'row', id: 'draft:n3', side: 'out', add: true })!.body;
		const same = rootEntries(grownBody, f, { methods: [], testTypes: [] }).find((e) => e.id === 'sample:same');
		expect(same?.disabled).toBeUndefined();
	});

	it('counts a sample of the loaded history as a sample card, with no end until the draft holds it', () => {
		expect(menuFor(body(), sock('sample', 'old', 'out'))).toEqual({ side: 'out', card: 'sample', end: null });
	});
});

describe('the entries', () => {
	it('from a sample output: operations by category (the lab\'s order, no category last), then the tests', () => {
		const b = body();
		const es = rootEntries(b, menuFor(b, sock('sample', 'draft:n1', 'out')), catalog);
		expect(sections(es)).toEqual(['From the database', 'Machining', 'FAST sintering', 'Other methods', 'Tests', 'Wire']);
		expect(labels(es)).toEqual(['From database…', 'Turning', 'Milling', 'FAST sintering', 'Mystery', 'Tensile', 'XRD', 'Connect to…']);
		expect(es.find((e) => e.label === 'Turning')?.detail).toBe('MC');
	});

	it('unconnected: the whole catalog, one flat list: the samples, the operations by category, the tests', () => {
		const es = rootEntries(body(), menuFor(body(), null), catalog);
		expect(es).toEqual(catalogEntries(catalog));
		expect(sections(es)).toEqual(['Samples', 'From the database', 'Machining', 'FAST sintering', 'Other methods', 'Tests']);
		expect(labels(es).slice(0, 3)).toEqual(['New sample', 'Existing sample…', 'From database…']);
		expect(es[1].choice).toEqual({ kind: 'pickSamples' });
		expect(es[2].choice).toEqual({ kind: 'fromDatabase' });
	});

	it('the operations alone (insert before and after) have no samples and no tests', () => {
		expect(sections(operationOnlyEntries(catalog))).toEqual(['Machining', 'FAST sintering', 'Other methods']);
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

	it('From database… is offered from a sample\'s output and unconnected, not at an operation, a test or a sample\'s input', () => {
		const b = body();
		const has = (s: SocketRef | null) => labels(rootEntries(b, menuFor(b, s), catalog)).includes('From database…');
		expect(has(sock('sample', 'draft:n1', 'out'))).toBe(true);
		expect(has(null)).toBe(true);
		expect(has(sock('sample', 'draft:n5', 'in'))).toBe(false);
		expect(has(sock('row', 'draft:n3', 'out'))).toBe(false);
		expect(has(sock('row', 'draft:n3', 'in'))).toBe(false);
		expect(has(sock('row', 'draft:n4', 'in'))).toBe(false);
		// the operations alone (insert before / after) never list it
		expect(labels(operationOnlyEntries(catalog))).not.toContain('From database…');
	});

	it('is found by typing "database" or "attach", and is not a recent', () => {
		const es = rootEntries(body(), menuFor(body(), null), catalog);
		expect(labels(searchEntries(es, 'database'))).toEqual(['From database…']);
		expect(labels(searchEntries(es, 'attach'))).toEqual(['From database…']);
		expect(recentIdOf({ kind: 'fromDatabase' })).toBeNull();
		expect(recentIdOf({ kind: 'attachOperation', id: 'o', version: 1, workState: 'planned' })).toBeNull();
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

describe('searching the list', () => {
	const es = rootEntries(body(), menuFor(body(), null), catalog);

	it('keeps the entries that have every word, in the label, the detail, the section or the keys', () => {
		expect(labels(searchEntries(es, 'mill'))).toEqual(['Milling']);
		expect(labels(searchEntries(es, 'MF'))).toEqual(['FAST sintering']);
		expect(labels(searchEntries(es, 'machining'))).toEqual(['Turning', 'Milling']);
		expect(labels(searchEntries(es, 'tests ten'))).toEqual(['Tensile']);
		expect(labels(searchEntries(es, 'sintering'))).toEqual(['FAST sintering']); // its category, its name
		expect(searchEntries(es, 'zzz')).toEqual([]);
		expect(searchEntries(es, '  ')).toHaveLength(es.length);
	});

	it('finds a test by its type value and a method by its category key even when the label says otherwise', () => {
		const odd: MenuCatalog = { methods: [{ id: 'h', name: 'Furnace run', code: 'HT', category: 'heat_treatment' }], testTypes: [{ value: 'uts', name: 'Pull test' }] };
		const list = catalogEntries(odd);
		expect(labels(searchEntries(list, 'uts'))).toEqual(['Pull test']);
		expect(labels(searchEntries(list, 'heat_treatment'))).toEqual(['Furnace run']);
	});

	it('ranks a label that starts with the word first, then a word that starts with it, then the rest', () => {
		const list = catalogEntries({
			methods: [
				{ id: 'a', name: 'Wire turning', code: 'W1', category: 'machining' },
				{ id: 'b', name: 'Turning', code: 'T1', category: 'machining' },
				{ id: 'c', name: 'Mill', code: 'TURN', category: 'machining' },
			],
			testTypes: [],
		});
		expect(labels(searchEntries(list, 'turn'))).toEqual(['Turning', 'Wire turning', 'Mill']);
	});

	it('puts what was chosen lately first among equals, and the recents on top with nothing typed (each entry once)', () => {
		const r = ['test:xrd', 'op:mm'];
		expect(labels(searchEntries(es, 'mill', r))).toEqual(['Milling']);
		expect(labels(searchEntries(es, 'machining', r))).toEqual(['Milling', 'Turning']);
		const idle = searchEntries(es, '', r);
		expect(idle.slice(0, 2).map((e) => [e.label, e.section])).toEqual([['XRD', 'Recent'], ['Milling', 'Recent']]);
		expect(idle).toHaveLength(es.length);
		expect(new Set(idle.map((e) => e.id)).size).toBe(idle.length);
		expect(idle.filter((e) => e.label === 'Milling')).toHaveLength(1);
	});

	it('does not put an entry that cannot be chosen among the recents', () => {
		const grey = es.map((e) => (e.id === 'op:mm' ? { ...e, disabled: 'no' } : e));
		expect(searchEntries(grey, '', ['op:mm']).find((e) => e.id === 'op:mm')?.section).toBe('Machining');
	});

	it('an unknown recent is ignored', () => {
		expect(searchEntries(es, '', ['op:gone'])).toEqual(es);
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

	it('an operation from the database is attached to the sample whose output the menu is for, with the version it was read at', () => {
		const choice: MenuChoice = { kind: 'attachOperation', id: 'op-9', version: 4, workState: 'planned' };
		const b = doIt(body(), sock('sample', 'draft:n5', 'out'), choice, { at });
		expect(b.items.at(-1)).toMatchObject({ kind: 'operation', existing: { id: 'op-9', version: 4 }, attach: true, workState: 'planned' });
		expect(b.wires.at(-1)).toEqual({ from: { key: 'n5' }, to: { key: 'n6', row: 0 } });
		expect(b.positions.n6).toEqual(at);
		// unconnected: it lands floating, unattached
		const floating = doIt(body(), null, { ...choice, workState: 'done' });
		expect(floating.items.at(-1)).toMatchObject({ existing: { id: 'op-9', version: 4 }, attach: true, workState: 'done' });
		expect(floating.wires).toEqual(body().wires);
		// one step
		expect(actionsFor(target(body(), sock('sample', 'draft:n5', 'out')), choice)).toHaveLength(1);
	});

	it('an operation from the database fits nowhere but a sample\'s output (or nowhere in particular)', () => {
		const choice: MenuChoice = { kind: 'attachOperation', id: 'op-9', version: 4, workState: 'planned' };
		for (const s of [sock('sample', 'draft:n5', 'in'), sock('row', 'draft:n3', 'out'), sock('row', 'draft:n3', 'in'), sock('row', 'draft:n4', 'in')]) {
			expect(actionsFor(target(body(), s), choice)).toEqual([]);
		}
		// opening the picker is not an action
		expect(actionsFor(target(body(), sock('sample', 'draft:n5', 'out')), { kind: 'fromDatabase' })).toEqual([]);
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

// ---- templates in the catalog (redesign R7) ----------------------------------------------------------------------------------

describe('templates in the catalog', () => {
	const tplOp = (id: string, name: string, values: Record<string, unknown>, extra: Partial<TemplateItem> = {}): TemplateItem => ({
		rec: { id, name, scope: 'private', role_id: null, collection: 'manufacturing_operations', values, user_id: 'u1', updated_at: 'now', version: 1 },
		mine: true,
		...extra,
	});
	const tplTest = (id: string, name: string, values: Record<string, unknown>): TemplateItem => ({
		rec: { id, name, scope: 'global', role_id: null, collection: 'test_sessions', values, user_id: 'u2', updated_at: 'now', version: 1 },
		mine: false,
	});
	const templates = [tplOp('t1', 'Roughing pass', { method_id: 'mt', equipment_id: 'e1', tool_id: 'tool1' }), tplTest('t2', 'Pull to break', { test_type: 'tensile', equipment_id: 'e2' })];
	const withTemplates: MenuCatalog = { ...catalog, templates };
	const tpl = (es: MenuEntry[]) => es.filter((e) => e.template);
	const doIt = (b: DraftBody, s: SocketRef | null, choice: MenuChoice, over: { at?: { x: number; y: number } } = {}) => {
		const f = menuFor(b, s);
		return run(actionsFor({ body: b, end: f.end, side: f.side, card: f.card, at: over.at }, choice), b);
	};

	it('puts the Templates group first in the whole catalog, above the samples and the categories', () => {
		const es = catalogEntries(withTemplates);
		expect(sections(es)[0]).toBe('Templates');
		expect(labels(es).slice(0, 3)).toEqual(['Pull to break', 'Roughing pass', 'New sample']);
		expect(labels(catalogEntries(catalog))[0]).toBe('New sample'); // no templates, no empty group
	});

	it('offers them at a sample output (operations and tests) and a sample input (operations only), not at an operation or a test', () => {
		const b = body();
		expect(labels(tpl(rootEntries(b, menuFor(b, sock('sample', 'draft:n5', 'out')), withTemplates)))).toEqual(['Pull to break', 'Roughing pass']);
		expect(labels(tpl(rootEntries(b, menuFor(b, sock('sample', 'draft:n5', 'in')), withTemplates)))).toEqual(['Roughing pass']);
		expect(tpl(rootEntries(b, menuFor(b, sock('row', 'draft:n3', 'out')), withTemplates))).toEqual([]);
		expect(tpl(rootEntries(b, menuFor(b, sock('row', 'draft:n3', 'in')), withTemplates))).toEqual([]);
	});

	it('offers the operation templates to an insert, before the methods', () => {
		const es = operationOnlyEntries(withTemplates);
		expect(labels(es).slice(0, 2)).toEqual(['Roughing pass', 'Turning']);
		expect(labels(tpl(es))).toEqual(['Roughing pass']);
	});

	it('resolves the whole catalog in one order: templates, samples, From database…, then the categories as built', () => {
		const es = catalogEntries(withTemplates);
		expect(labels(es)).toEqual(['Pull to break', 'Roughing pass', 'New sample', 'Existing sample…', 'From database…', 'Turning', 'Milling', 'FAST sintering', 'Mystery', 'Tensile', 'XRD']);
		expect(sections(es)).toEqual(['Templates', 'Samples', 'From the database', 'Machining', 'FAST sintering', 'Other methods', 'Tests']);
		expect(rootEntries(body(), menuFor(body(), null), withTemplates)).toEqual(es);
	});

	it('from a sample output: the templates, then From database…, then the categories (operations, then tests), then Connect to…', () => {
		const b = body();
		const es = rootEntries(b, menuFor(b, sock('sample', 'draft:n5', 'out')), withTemplates);
		expect(labels(es)).toEqual(['Pull to break', 'Roughing pass', 'From database…', 'Turning', 'Milling', 'FAST sintering', 'Mystery', 'Tensile', 'XRD', 'Connect to…']);
		expect(sections(es)).toEqual(['Templates', 'From the database', 'Machining', 'FAST sintering', 'Other methods', 'Tests', 'Wire']);
	});

	it('from a sample input: the operation templates, then the operation categories only, with no From database… and no tests', () => {
		const b = body();
		const es = rootEntries(b, menuFor(b, sock('sample', 'draft:n5', 'in')), withTemplates);
		expect(labels(es)).toEqual(['Roughing pass', 'Turning', 'Milling', 'FAST sintering', 'Mystery', 'Connect to…']);
		expect(es.some((e) => e.label === 'From database…' || e.choice.kind === 'fromDatabase')).toBe(false);
		expect(es.some((e) => e.section === 'Tests')).toBe(false);
	});

	it('an insert offers the operation templates and the methods, but neither From database… nor the samples nor the tests', () => {
		const es = operationOnlyEntries(withTemplates);
		expect(labels(es)).toEqual(['Roughing pass', 'Turning', 'Milling', 'FAST sintering', 'Mystery']);
		expect(sections(es)).toEqual(['Templates', 'Machining', 'FAST sintering', 'Other methods']);
		expect(es.some((e) => e.choice.kind === 'fromDatabase' || e.section === 'Samples' || e.section === 'Tests')).toBe(false);
	});

	it('finds one by its name or by the method or test type it is made of, ahead of the method itself', () => {
		const es = catalogEntries(withTemplates);
		expect(labels(searchEntries(es, 'rough'))).toEqual(['Roughing pass']);
		expect(labels(searchEntries(es, 'pull'))).toEqual(['Pull to break']);
		expect(labels(searchEntries(es, 'turning'))).toEqual(['Turning', 'Roughing pass']); // a label match ranks first, then the template made of it
		expect(searchEntries(es, 'tensile').map((e) => e.id)).toEqual(['test:tensile', 'tpl:t2']); // the test's own label first, then the template made of it
		expect(labels(searchEntries(es, 'template'))).toEqual(['Pull to break', 'Roughing pass']);
	});

	it('keeps the Templates group first while the recents are on top of the rest', () => {
		const es = searchEntries(catalogEntries(withTemplates), '', ['op:mf']);
		expect(es.map((e) => e.section).slice(0, 4)).toEqual(['Templates', 'Templates', 'Recent', 'Samples']);
		expect(es.filter((e) => e.id === 'op:mf')).toHaveLength(1);
	});

	it('a template operation adds a container with the template values, not linked to the template', () => {
		const choice = templateEntries([templates[0]], catalog)[0].choice;
		const b = doIt(body(), sock('sample', 'draft:n5', 'out'), choice, { at: { x: 5, y: 6 } });
		const made = b.items.at(-1) as DraftOperation;
		expect(made).toMatchObject({ kind: 'operation', workState: 'planned', values: { method_id: 'mt', equipment_id: 'e1', tool_id: 'tool1', process_category: 'machining' } });
		expect(b.wires.at(-1)).toEqual({ from: { key: 'n5' }, to: { key: made.key, row: 0 } });
		expect(JSON.stringify(made)).not.toContain('t1'); // nothing of the template is kept, not even its id
		// The container's values are a copy: the template's own are untouched.
		expect(templates[0].rec.values).toEqual({ method_id: 'mt', equipment_id: 'e1', tool_id: 'tool1' });
	});

	it('a template test adds a test with the template values; on empty canvas both stand alone', () => {
		const b = doIt(body(), sock('sample', 'draft:n5', 'out'), templateEntries([templates[1]], catalog)[0].choice);
		expect(b.items.at(-1)).toMatchObject({ kind: 'test', workState: 'planned', values: { test_type: 'tensile', equipment_id: 'e2' } });
		const alone = doIt(body(), null, templateEntries([templates[0]], catalog)[0].choice);
		expect(alone.items.at(-1)).toMatchObject({ kind: 'operation', values: { method_id: 'mt', equipment_id: 'e1' } });
		expect(alone.wires).toEqual(body().wires);
	});

	it('a template operation at a free sample input makes the operation and wires it to make that sample', () => {
		const b = doIt(body(), sock('sample', 'draft:n5', 'in'), templateEntries([templates[0]], catalog)[0].choice);
		const made = b.items.at(-1) as DraftOperation;
		expect(made.values).toMatchObject({ method_id: 'mt', tool_id: 'tool1' });
		expect(b.wires.at(-1)).toEqual({ from: { key: made.key, row: 0 }, to: { key: 'n5' } });
	});

	it('carries a gear warning on the entry and does not block it', () => {
		const warned = templateEntries([tplOp('t3', 'Old tool', { method_id: 'mt', tool_id: 'x' }, { warn: 'The tool X is retired.' })], catalog)[0];
		expect(warned.warn).toBe('The tool X is retired.');
		expect(warned.disabled).toBeUndefined();
		expect(firstChoosable([warned])).toBe(0);
	});
});
