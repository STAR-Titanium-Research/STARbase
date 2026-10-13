import { describe, expect, it } from 'vitest';
import { clickAction, MENU_MAX_HEIGHT, placeMenu } from './railMenu';

const vp = { viewportWidth: 1280, viewportHeight: 800 };

describe('placeMenu', () => {
	it('sits at the rail edge, level with the icon', () => {
		expect(placeMenu({ anchorTop: 200, edge: 60, menuHeight: 300, ...vp })).toEqual({ left: 60, top: 200, maxHeight: MENU_MAX_HEIGHT });
	});
	it('slides up to stay inside the window', () => {
		expect(placeMenu({ anchorTop: 700, edge: 60, menuHeight: 300, ...vp }).top).toBe(800 - 300 - 8);
	});
	it('limits a tall menu to 480px and keeps it in the window', () => {
		const p = placeMenu({ anchorTop: 700, edge: 60, menuHeight: 900, ...vp });
		expect(p.maxHeight).toBe(480);
		expect(p.top).toBe(800 - 480 - 8);
	});
	it('limits the height to a short window', () => {
		const p = placeMenu({ anchorTop: 100, edge: 60, menuHeight: 900, viewportWidth: 1280, viewportHeight: 400 });
		expect(p.maxHeight).toBe(384);
		expect(p.top).toBe(8);
	});
	it('never starts above the top margin', () => {
		expect(placeMenu({ anchorTop: -20, edge: 60, menuHeight: 100, ...vp }).top).toBe(8);
	});
	it('keeps the menu inside a narrow window', () => {
		expect(placeMenu({ anchorTop: 100, edge: 60, menuHeight: 100, viewportWidth: 250, viewportHeight: 800 }).left).toBe(26);
	});
	it('places an unmeasured menu at the icon', () => {
		expect(placeMenu({ anchorTop: 120, edge: 60, menuHeight: 0, ...vp }).top).toBe(120);
	});
});

describe('clickAction', () => {
	it('a mouse click keeps a menu that hover opened', () => {
		expect(clickAction('mouse', true)).toBe('keep');
		expect(clickAction('mouse', false)).toBe('open');
	});
	it('a tap or a key press toggles', () => {
		expect(clickAction('touch', false)).toBe('open');
		expect(clickAction('touch', true)).toBe('close');
		expect(clickAction('', true)).toBe('close');
		expect(clickAction('pen', false)).toBe('open');
	});
});
