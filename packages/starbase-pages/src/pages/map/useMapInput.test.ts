import { describe, expect, it } from 'vitest';
import { cardOf, isKeyboardFocus, keyTarget, type ElLike } from './keyboard';
import { focusReveal, keyDecision, resetsScroll } from './useMapInput';

const card = (id: string): ElLike => ({ dataset: { id } });
const slot = (mapId: string): ElLike => ({ dataset: { mapId } });
const CONTROL = 'button, a, [role="button"]';
function el(opts: { tag?: string; matches?: Record<string, ElLike>; focusVisible?: boolean } = {}): ElLike & { matches(sel: string): boolean } {
	return {
		tagName: opts.tag ?? 'DIV',
		closest: (sel) => opts.matches?.[sel] ?? null,
		matches: (sel) => (sel === ':focus-visible' ? (opts.focusVisible ?? true) : false),
	};
}

describe('keyDecision (spec D23)', () => {
	it('Enter on a card selects, + expands, o opens', () => {
		const t = keyTarget(el({ matches: { '.vue-flow__node': card('op:o1') } }));
		expect(keyDecision({ key: 'Enter' }, t)).toEqual({ do: 'select', id: 'op:o1' });
		expect(keyDecision({ key: '+' }, t)).toEqual({ do: 'expand', id: 'op:o1' });
		expect(keyDecision({ key: 'o' }, t)).toEqual({ do: 'open', id: 'op:o1' });
	});

	it('Enter on a button or link inside a card is the button\'s, not a select of the card', () => {
		const ex = el({ tag: 'BUTTON', matches: { '.vue-flow__node': card('op:o1'), [CONTROL]: {} } });
		const t = keyTarget(ex);
		expect(t.control).toBe(true);
		expect(keyDecision({ key: 'Enter' }, t)).toEqual({ do: 'none' });
		// ...but + and o still mean the card the button is on
		expect(keyDecision({ key: '+' }, t)).toEqual({ do: 'expand', id: 'op:o1' });
		expect(keyDecision({ key: 'o' }, t)).toEqual({ do: 'open', id: 'op:o1' });
	});

	it('Escape clears the hover card, wherever in the canvas focus is', () => {
		expect(keyDecision({ key: 'Escape' }, keyTarget(el()))).toEqual({ do: 'clearHover' });
		expect(keyDecision({ key: 'Escape' }, keyTarget(el({ matches: { '.vue-flow__node': card('s:s1') } })))).toEqual({ do: 'clearHover' });
	});

	it('does nothing while a field takes the key, Escape included, or with no record in focus', () => {
		const typing = keyTarget(el({ tag: 'INPUT', matches: { '.vue-flow__node': card('s:s1') } }));
		for (const key of ['Enter', '+', 'o', 'Escape']) expect(keyDecision({ key }, typing)).toEqual({ do: 'none' });
		const socket = keyTarget(el({ matches: { '.vue-flow__handle': {}, '.vue-flow__node': card('s:s1') } }));
		for (const key of ['Enter', '+', 'o']) expect(keyDecision({ key }, socket)).toEqual({ do: 'none' });
		expect(keyDecision({ key: 'o' }, keyTarget(el()))).toEqual({ do: 'none' });
	});

	it('keeps Ctrl+O and Ctrl++ for the browser', () => {
		const t = keyTarget(el({ matches: { '.vue-flow__node': card('s:s1') } }));
		expect(keyDecision({ key: 'o', ctrlKey: true }, t)).toEqual({ do: 'none' });
		expect(keyDecision({ key: '+', metaKey: true }, t)).toEqual({ do: 'none' });
	});
});

describe('focusReveal', () => {
	it('keyboard focus on a card reveals that card', () => {
		expect(focusReveal(el({ matches: { '.vue-flow__node': card('op:o1') } }))).toBe('op:o1');
	});

	it('keyboard focus on a slot reveals the card holding it, not the slot\'s own key', () => {
		const t = el({ matches: { '[data-map-id]': slot('tools:t1'), '.vue-flow__node': card('op:o1') } });
		expect(focusReveal(t)).toBe('op:o1');
		expect(cardOf(t)?.id).toBe('op:o1');
	});

	it('a mouse click\'s focus (not :focus-visible) never pans or resets scroll', () => {
		expect(focusReveal(el({ focusVisible: false, matches: { '.vue-flow__node': card('op:o1') } }))).toBeNull();
	});

	it('nothing outside a card (the controls) reveals', () => {
		expect(focusReveal(el())).toBeNull();
		expect(focusReveal(null)).toBeNull();
	});
});

describe('isKeyboardFocus / resetsScroll', () => {
	it('reads :focus-visible, and counts an element that cannot answer as keyboard', () => {
		expect(isKeyboardFocus(el({ focusVisible: true }))).toBe(true);
		expect(isKeyboardFocus(el({ focusVisible: false }))).toBe(false);
		expect(isKeyboardFocus({})).toBe(true);
		expect(isKeyboardFocus(null)).toBe(true);
	});

	it('resets only Vue Flow\'s own clipping containers', () => {
		const is = (...classes: string[]) => ({ matches: (sel: string) => sel.split(',').some((s) => classes.includes(s.trim().slice(1))) }) as unknown as ElLike;
		for (const c of ['vue-flow', 'vue-flow__viewport', 'vue-flow__renderer', 'vue-flow__pane']) expect(resetsScroll(is(c))).toBe(true);
		expect(resetsScroll(is('pm-canvas'))).toBe(false);
		expect(resetsScroll(is('d1-page'))).toBe(false); // the page's own scroller is none of ours
		expect(resetsScroll({})).toBe(false);
	});
});
