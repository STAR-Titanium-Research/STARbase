// What the Add menu offers and what a choice does (spec E8), without Vue or the DOM. The menu is a search box over sections:
// Templates (stream E fills the list), then, by what it is for,
//
//   from a sample's output, or unconnected   Operations (by process category → method), Tests (by test type); unconnected also Samples
//   from an operation's output               New sample / Same sample (in place) / Existing sample…
//   from a free input                        New sample / Existing sample…  (a sample's input: the operations that could make it)
//
// `rootEntries` lists them, `filterEntries` narrows them to a query, `actionsFor` turns a choice into the reducer actions it stands
// for (applied as one undoable step), and `placeMenu` keeps the menu inside the window. Entries that cannot be chosen are listed
// greyed with the reason, so the person sees why instead of wondering where the entry went.

import { processLabel, type DraftBody, type DraftKey } from '@d1/ui';
import type { ProcessCategory } from '../model/types';
import type { MethodEntry, TestTypeEntry } from './catalog';
import { CATEGORIES } from './catalog';
import { inputSampleOf, itemOf, nextKey, wireProblem, type DraftAction, type Pos, type WireEnd } from './draft';
import { grown, resolveEnd, type SocketRef } from './socketRefs';

/** A saved template of an operation or a test (stream E): what the menu needs of it. */
export interface TemplateEntry {
	id: string;
	name: string;
	collection: 'manufacturing_operations' | 'test_sessions';
	values: Record<string, unknown>;
	/** Greyed in the list, with the reason (a tool or edge it points at is depleted or retired). */
	disabled?: string;
}

export type MenuChoice =
	| { kind: 'operation'; methodId: string; category: ProcessCategory }
	| { kind: 'test'; testType: string }
	| { kind: 'template'; template: TemplateEntry }
	| { kind: 'newSample' }
	/** The operation's output is the sample it took in: the work is done in place. */
	| { kind: 'sameSample' }
	/** Opens the search for a sample on the canvas (an output) or in the database (an input). */
	| { kind: 'existingSample' }
	/** The sample picker, over the canvas. */
	| { kind: 'pickSamples' }
	/** "Connect to…": the sockets this one can be wired to, by code (E21). */
	| { kind: 'connectTo' }
	/** A sample that is in the draft, wired to the socket the menu is for. */
	| { kind: 'wireSample'; key: DraftKey }
	/** A sample found in the database: the page adds it to the draft (with its version), then it is a `wireSample`. */
	| { kind: 'record'; id: string; code: string };

export interface MenuEntry {
	id: string;
	section: string;
	label: string;
	detail?: string;
	choice: MenuChoice;
	/** Why it cannot be chosen now. */
	disabled?: string;
}

/** What the menu is for: the socket it was opened on, as the draft sees it. */
export interface MenuFor {
	side: 'in' | 'out' | null;
	/** The kind of card the socket is on. */
	card: 'sample' | 'operation' | 'test' | null;
	end: WireEnd | null;
}

/** The menu's purpose for a socket (null socket: the unconnected menu). A sample the draft does not hold yet counts as a sample card. */
export function menuFor(body: DraftBody, sock: SocketRef | null): MenuFor {
	if (!sock) return { side: null, card: null, end: null };
	// A free socket that stands for a new row is read as the draft would be with the row.
	if (sock.add) {
		const g = grown(body, sock);
		if (g) body = g.body;
	}
	if (sock.kind === 'sample') return { side: sock.side, card: 'sample', end: resolveEnd(body, sock) };
	const end = resolveEnd(body, sock);
	const item = end ? itemOf(body, end.key) : undefined;
	return { side: sock.side, card: item?.kind === 'test' ? 'test' : 'operation', end };
}

const OTHER = 'Other methods';
const categoryLabel = (c: ProcessCategory): string => (c ? processLabel(c) : OTHER);

/** Operation entries by process category (the categories in the lab's order, then methods with no category), methods by name. */
function operationEntries(methods: readonly MethodEntry[]): MenuEntry[] {
	const out: MenuEntry[] = [];
	for (const c of [...CATEGORIES, null] as ProcessCategory[]) {
		for (const m of methods.filter((x) => x.category === c)) {
			out.push({ id: `op:${m.id}`, section: categoryLabel(c), label: m.name, detail: m.code || undefined, choice: { kind: 'operation', methodId: m.id, category: m.category } });
		}
	}
	return out;
}

const testEntries = (types: readonly TestTypeEntry[]): MenuEntry[] =>
	types.map((t) => ({ id: `test:${t.value}`, section: 'Tests', label: t.name, choice: { kind: 'test', testType: t.value } }));

const templateEntries = (templates: readonly TemplateEntry[]): MenuEntry[] =>
	templates.map((t) => ({
		id: `tpl:${t.id}`,
		section: 'Templates',
		label: t.name,
		detail: t.collection === 'test_sessions' ? 'Test' : 'Operation',
		choice: { kind: 'template', template: t },
		...(t.disabled ? { disabled: t.disabled } : {}),
	}));

export interface MenuCatalog {
	methods: readonly MethodEntry[];
	testTypes: readonly TestTypeEntry[];
	templates?: readonly TemplateEntry[];
}

/** The entries of the menu when nothing has been typed. A socket's menu ends with Connect to… (a test has no output to connect). */
export function rootEntries(body: DraftBody, f: MenuFor, cat: MenuCatalog): MenuEntry[] {
	const entries = baseEntries(body, f, cat);
	if (f.side === null || (f.side === 'out' && f.card === 'test')) return entries;
	return [...entries, { id: 'connect', section: 'Wire', label: 'Connect to…', detail: 'a socket on the canvas, by code', choice: { kind: 'connectTo' } }];
}

function baseEntries(body: DraftBody, f: MenuFor, cat: MenuCatalog): MenuEntry[] {
	const out: MenuEntry[] = [];
	if (f.side === 'out' && (f.card === 'operation' || f.card === 'test')) {
		if (f.card === 'test') return [];
		const input = f.end ? inputSampleOf(body, f.end) : null;
		out.push({ id: 'sample:new', section: 'Sample', label: 'New sample', detail: 'this operation makes a new one', choice: { kind: 'newSample' } });
		out.push({
			id: 'sample:same',
			section: 'Sample',
			label: 'Same sample',
			detail: 'in place: the sample carries on',
			choice: { kind: 'sameSample' },
			...(input ? {} : { disabled: 'Wire a sample into this operation first.' }),
		});
		out.push({ id: 'sample:existing', section: 'Sample', label: 'Existing sample…', detail: 'one already on the canvas', choice: { kind: 'existingSample' } });
		return out;
	}
	if (f.side === 'in' && (f.card === 'operation' || f.card === 'test')) {
		out.push({ id: 'sample:new', section: 'Sample', label: 'New sample', detail: 'feeds this in', choice: { kind: 'newSample' } });
		out.push({ id: 'sample:existing', section: 'Sample', label: 'Existing sample…', detail: 'search the samples', choice: { kind: 'existingSample' } });
		return out;
	}
	// From a sample's output, a sample's input, or unconnected: the containers that can be made.
	const containers = [...templateEntries(cat.templates ?? []), ...operationEntries(cat.methods)];
	if (f.side !== 'in') containers.push(...testEntries(cat.testTypes));
	out.push(...containers);
	if (f.side === null) {
		out.push({ id: 'sample:new', section: 'Samples', label: 'New sample', detail: 'a blank card', choice: { kind: 'newSample' } });
		out.push({ id: 'sample:pick', section: 'Samples', label: 'Pick samples…', detail: 'from the Samples list', choice: { kind: 'pickSamples' } });
	}
	return out;
}

/** Samples on the canvas that an operation's output could be wired to (the others greyed, with the draft's reason). */
export function canvasSampleEntries(body: DraftBody, end: WireEnd | null, codeOf: (key: DraftKey) => string): MenuEntry[] {
	const out: MenuEntry[] = [];
	for (const item of body.items) {
		if (item.kind !== 'sample' || item.remove) continue;
		const problem = end ? wireProblem(body, end, { key: item.key }) : 'Wire this operation to the draft first.';
		out.push({
			id: `canvas:${item.key}`,
			section: 'Samples on the canvas',
			label: codeOf(item.key),
			detail: item.existing ? 'existing' : 'new',
			choice: { kind: 'wireSample', key: item.key },
			...(problem ? { disabled: problem } : {}),
		});
	}
	return out;
}

/** Entries whose label, detail or section contains every word of the query, in any case. */
export function filterEntries(entries: readonly MenuEntry[], query: string): MenuEntry[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...entries];
	return entries.filter((e) => {
		const hay = `${e.label} ${e.detail ?? ''} ${e.section}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** The next entry that can be chosen from `from` (-1: none yet), in `dir`; wraps; -1 when none can. */
export function moveActive(entries: readonly MenuEntry[], from: number, dir: 1 | -1): number {
	const n = entries.length;
	if (!n) return -1;
	for (let step = 1; step <= n; step++) {
		const i = (((from < 0 ? (dir === 1 ? -1 : 0) : from) + dir * step) % n + n) % n;
		if (!entries[i].disabled) return i;
	}
	return -1;
}

/** The first entry that can be chosen (what Enter takes after typing). */
export const firstChoosable = (entries: readonly MenuEntry[]): number => entries.findIndex((e) => !e.disabled);

/** Where a menu opened at `at` of the given size sits so that it stays inside the window. */
export function placeMenu(at: { x: number; y: number }, size: { width: number; height: number }, view: { width: number; height: number }, margin = 8): { left: number; top: number } {
	const left = Math.max(margin, Math.min(at.x, view.width - size.width - margin));
	const top = Math.max(margin, Math.min(at.y, view.height - size.height - margin));
	return { left, top };
}

// ---- what a choice does ------------------------------------------------------------------------------------

export interface ChoiceTarget {
	body: DraftBody;
	/** The socket's end, resolved (the sample added to the draft first when it was one of the loaded history); null when unconnected. */
	end: WireEnd | null;
	side: 'in' | 'out' | null;
	card: MenuFor['card'];
	/** Where a card the choice adds is put (the map's coordinates). */
	at?: Pos;
}

/** The values a new container starts with: its method (and the process category the typed fields of the form hang on). */
const operationValues = (methodId: string, category: ProcessCategory): Record<string, unknown> => ({ method_id: methodId, ...(category ? { process_category: category } : {}) });

/**
 * The reducer actions a choice stands for, to be applied as one undoable step. Empty when the choice does not fit the socket (the
 * menu does not offer those, but a stale menu might still ask). A container made from a sample's output is wired to it; made from
 * a sample's input it is wired to make that sample; unconnected it stands alone.
 */
export function actionsFor(t: ChoiceTarget, choice: MenuChoice): DraftAction[] {
	const { body, end, side, at } = t;
	const container = (kind: 'operation' | 'test', source: Extract<DraftAction, { type: 'addContainer' }>['source']): DraftAction[] => {
		if (side === 'out' && t.card === 'sample' && end) return [{ type: 'addContainer', kind, source, from: end, at }];
		if (side === 'in' && t.card === 'sample' && end) {
			// The operation makes this sample: its first output row is wired to it. The keys the new item and its row get are known in advance.
			if (kind !== 'operation') return [];
			return [{ type: 'addContainer', kind, source, at }, { type: 'wire', from: { key: nextKey(body), row: 0 }, to: end }];
		}
		return side === null ? [{ type: 'addContainer', kind, source, at }] : [];
	};
	switch (choice.kind) {
		case 'operation':
			return container('operation', { from: 'template', values: operationValues(choice.methodId, choice.category) });
		case 'test':
			return container('test', { from: 'blank', testType: choice.testType });
		case 'template': {
			const kind = choice.template.collection === 'test_sessions' ? 'test' : 'operation';
			return container(kind, { from: 'template', values: choice.template.values });
		}
		case 'newSample':
			if (side === null) return [{ type: 'addSample', at }];
			if (side === 'out' && t.card === 'operation' && end) return [{ type: 'addSample', from: end, at }];
			if (side === 'in' && (t.card === 'operation' || t.card === 'test') && end) return [{ type: 'addSample', at }, { type: 'wire', from: { key: nextKey(body) }, to: end }];
			return [];
		case 'sameSample': {
			const input = end && side === 'out' && t.card === 'operation' ? inputSampleOf(body, end) : null;
			return end && input ? [{ type: 'wire', from: end, to: { key: input } }] : [];
		}
		case 'wireSample':
			if (!end || !itemOf(body, choice.key)) return [];
			return side === 'in' ? [{ type: 'wire', from: { key: choice.key }, to: end }] : side === 'out' ? [{ type: 'wire', from: end, to: { key: choice.key } }] : [];
		default:
			return [];
	}
}

/** What a sample of the draft is called in menus: its record's code when known, else what its card says. */
export function sampleLabel(body: DraftBody, key: DraftKey, known: (id: string) => string | undefined): string {
	const item = body.items.find((i) => i.key === key);
	if (item?.kind !== 'sample') return key;
	if (item.existing) return known(item.existing.id) ?? 'Sample';
	const code = typeof item.values.sample_code === 'string' ? item.values.sample_code.replace(/^\{seq\}-?/, '') : '';
	return code ? `New sample ${code}` : 'New sample';
}
