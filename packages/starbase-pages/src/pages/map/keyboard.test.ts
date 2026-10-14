import { describe, expect, it } from 'vitest';
import { keyTarget, mapElement, mapKey, type ElLike } from './keyboard';

describe('mapKey (spec D23)', () => {
	it('Enter selects, + expands, o opens the focused record', () => {
		expect(mapKey({ key: 'Enter' }, 's:s1')).toEqual({ action: 'select', id: 's:s1' });
		expect(mapKey({ key: '+' }, 's:s1')).toEqual({ action: 'expand', id: 's:s1' });
		expect(mapKey({ key: 'o' }, 'tools:t1')).toEqual({ action: 'open', id: 'tools:t1' });
		expect(mapKey({ key: 'O' }, 'tools:t1')).toEqual({ action: 'open', id: 'tools:t1' }); // caps lock
	});

	it('does nothing without a focused record', () => {
		for (const key of ['Enter', '+', 'o']) expect(mapKey({ key }, null)).toEqual({ action: 'none' });
	});

	it('leaves Ctrl, Cmd and Alt combinations to the browser (Ctrl+O, Ctrl++)', () => {
		expect(mapKey({ key: 'o', ctrlKey: true }, 's:s1')).toEqual({ action: 'none' });
		expect(mapKey({ key: '+', ctrlKey: true }, 's:s1')).toEqual({ action: 'none' });
		expect(mapKey({ key: 'o', metaKey: true }, 's:s1')).toEqual({ action: 'none' });
		expect(mapKey({ key: 'Enter', altKey: true }, 's:s1')).toEqual({ action: 'none' });
	});

	it('ignores every other key, Escape included (the page clears the hover card itself)', () => {
		for (const key of ['Escape', 'Tab', 'a', ' ', '-', 'ArrowRight']) expect(mapKey({ key }, 's:s1')).toEqual({ action: 'none' });
	});
});

// A stand-in for an Element: `closest` answers for the selectors the resolvers ask.
function el(opts: { tag?: string; editable?: boolean; matches?: Record<string, ElLike> } = {}): ElLike {
	return {
		tagName: opts.tag ?? 'DIV',
		isContentEditable: opts.editable,
		closest: (sel) => opts.matches?.[sel] ?? null,
	};
}
const card = (id: string): ElLike => ({ dataset: { id } });
const slot = (mapId: string): ElLike => ({ dataset: { mapId } });
const CONTROL = 'button, a, [role="button"]';

describe('mapElement / keyTarget', () => {
	it('a card is its Vue Flow wrapper (data-id)', () => {
		const wrapper = card('op:o1');
		const t = el({ matches: { '.vue-flow__node': wrapper } });
		expect(mapElement(t)).toEqual({ id: 'op:o1', el: wrapper });
		expect(keyTarget(t)).toEqual({ id: 'op:o1', typing: false, control: false });
	});

	it('a record in an Inside tray is its own element (data-map-id), ahead of the card holding it', () => {
		const s = slot('equipment:eq1');
		const t = el({ matches: { '[data-map-id]': s, '.vue-flow__node': card('op:o1'), [CONTROL]: s } });
		expect(keyTarget(t)).toEqual({ id: 'equipment:eq1', typing: false, control: true });
	});

	it('a focused socket has no record: keys do nothing there, focus only lists its wires', () => {
		const t = el({ matches: { '.vue-flow__handle': {}, '.vue-flow__node': card('op:o1') } });
		expect(keyTarget(t).id).toBeNull();
	});

	it('the controls, the pane and anything outside the map have no record', () => {
		expect(keyTarget(el()).id).toBeNull();
		expect(keyTarget(el({ matches: { [CONTROL]: {} } }))).toEqual({ id: null, typing: false, control: true });
		expect(keyTarget(null)).toEqual({ id: null, typing: false, control: false });
		expect(mapElement(undefined)).toBeNull();
	});

	it('never acts while a field takes the key', () => {
		for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(keyTarget(el({ tag, matches: { '.vue-flow__node': card('s:s1') } })).typing).toBe(true);
		expect(keyTarget(el({ editable: true })).typing).toBe(true);
		expect(keyTarget(el({ tag: 'DIV' })).typing).toBe(false);
	});
});
