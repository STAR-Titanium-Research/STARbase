import { describe, expect, it, vi } from 'vitest';
import { inOverlay, isTyping, keyDecision, useEditKeys, type EditKeysOptions } from './useEditKeys';

const free = { typing: false, blocked: false };
const d = (e: Parameters<typeof keyDecision>[0], state: Partial<Parameters<typeof keyDecision>[1]> = {}) => keyDecision(e, { ...free, ...state });

describe('edit keys: what each means', () => {
	it('Shift+A adds', () => {
		expect(d({ key: 'A', shiftKey: true })).toEqual({ do: 'add' });
		expect(d({ key: 'a', shiftKey: true })).toEqual({ do: 'add' });
		expect(d({ key: 'a' })).toBeNull();
	});

	it('Delete and Backspace remove', () => {
		expect(d({ key: 'Delete' })).toEqual({ do: 'remove' });
		expect(d({ key: 'Backspace' })).toEqual({ do: 'remove' });
		expect(d({ key: 'Delete', shiftKey: true })).toBeNull();
	});

	it('Ctrl/⌘+Delete (or Backspace) dissolves, and Shift+Ctrl+Delete does nothing', () => {
		expect(d({ key: 'Delete', ctrlKey: true })).toEqual({ do: 'dissolve' });
		expect(d({ key: 'Delete', metaKey: true })).toEqual({ do: 'dissolve' });
		expect(d({ key: 'Backspace', ctrlKey: true })).toEqual({ do: 'dissolve' });
		expect(d({ key: 'Delete', ctrlKey: true, shiftKey: true })).toBeNull();
		expect(d({ key: 'Delete', ctrlKey: true }, { typing: true })).toBeNull();
	});

	it('Shift+D and Ctrl/⌘+D duplicate; with both, ask how many', () => {
		expect(d({ key: 'D', shiftKey: true })).toEqual({ do: 'duplicate' });
		expect(d({ key: 'd', ctrlKey: true })).toEqual({ do: 'duplicate' });
		expect(d({ key: 'd', metaKey: true })).toEqual({ do: 'duplicate' });
		expect(d({ key: 'D', ctrlKey: true, shiftKey: true })).toEqual({ do: 'duplicateMany' });
		expect(d({ key: 'D', metaKey: true, shiftKey: true })).toEqual({ do: 'duplicateMany' });
		expect(d({ key: 'd' })).toBeNull();
	});

	it('Ctrl/⌘+Z undoes, with Shift (or Ctrl+Y) redoes', () => {
		expect(d({ key: 'z', ctrlKey: true })).toEqual({ do: 'undo' });
		expect(d({ key: 'z', metaKey: true })).toEqual({ do: 'undo' });
		expect(d({ key: 'Z', ctrlKey: true, shiftKey: true })).toEqual({ do: 'redo' });
		expect(d({ key: 'Z', metaKey: true, shiftKey: true })).toEqual({ do: 'redo' });
		expect(d({ key: 'y', ctrlKey: true })).toEqual({ do: 'redo' });
		expect(d({ key: 'z' })).toBeNull();
	});

	it('leaves other Ctrl and Alt keys to the browser', () => {
		expect(d({ key: 'a', ctrlKey: true, shiftKey: true })).toBeNull();
		expect(d({ key: 'c', ctrlKey: true })).toBeNull();
		expect(d({ key: 'A', shiftKey: true, altKey: true })).toBeNull();
		expect(d({ key: 'z', ctrlKey: true, altKey: true })).toBeNull();
	});

	it('is ignored while typing, and while a menu or the picker is open', () => {
		for (const e of [{ key: 'A', shiftKey: true }, { key: 'Delete' }, { key: 'z', ctrlKey: true }, { key: 'd', ctrlKey: true }]) {
			expect(keyDecision(e, { typing: true, blocked: false })).toBeNull();
			expect(keyDecision(e, { typing: false, blocked: true })).toBeNull();
		}
	});
});

describe('keys that are not the canvas\'s', () => {
	const keys = [{ key: 'A', shiftKey: true }, { key: 'Delete' }, { key: 'z', ctrlKey: true }];
	it('are ignored inside a dialog, listbox or menu, and when something already handled them', () => {
		for (const e of keys) {
			expect(keyDecision(e, { typing: false, blocked: false, inOverlay: true })).toBeNull();
			expect(keyDecision({ ...e, defaultPrevented: true }, free)).toBeNull();
		}
	});

	it('finds the overlay a key was pressed in, and not the canvas', () => {
		const inside = (hit: boolean) => ({ closest: (sel: string) => (hit && sel.includes('[role="dialog"]') && sel.includes('[role="listbox"]') && sel.includes('[role="menu"]') ? {} : null) });
		expect(inOverlay(inside(true))).toBe(true);
		expect(inOverlay(inside(false))).toBe(false);
		expect(inOverlay({})).toBe(false);
		expect(inOverlay(null)).toBe(false);
	});

	it('are left alone by the handler when pressed inside one', () => {
		const calls: string[] = [];
		const { onKeydown } = useEditKeys({ editing: () => true, blocked: () => false, pointer: () => ({ x: 0, y: 0 }), add: () => void calls.push('add'), undo: () => undefined, redo: () => undefined, remove: () => (calls.push('remove'), true), dissolve: () => (calls.push('dissolve'), true), duplicate: () => true, duplicateMany: () => true });
		const e = { key: 'Delete', target: { tagName: 'LI', closest: () => ({}) }, preventDefault: vi.fn() } as unknown as KeyboardEvent;
		onKeydown(e);
		expect(calls).toEqual([]);
		expect(e.preventDefault).not.toHaveBeenCalled();
	});
});

describe('what counts as typing', () => {
	it('is a field, a select, a text area or something editable', () => {
		for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTyping({ tagName })).toBe(true);
		expect(isTyping({ tagName: 'DIV', isContentEditable: true })).toBe(true);
		expect(isTyping({ tagName: 'BUTTON' })).toBe(false);
		expect(isTyping(null)).toBe(false);
	});
});

describe('the keydown handler', () => {
	const make = (over: Partial<EditKeysOptions> = {}) => {
		const calls: string[] = [];
		const o: EditKeysOptions = {
			editing: () => true,
			blocked: () => false,
			pointer: () => ({ x: 5, y: 6 }),
			add: (at) => void calls.push(`add ${at.x},${at.y}`),
			undo: () => void calls.push('undo'),
			redo: () => void calls.push('redo'),
			remove: () => (calls.push('remove'), true),
			dissolve: () => (calls.push('dissolve'), true),
			duplicate: () => (calls.push('duplicate'), true),
			duplicateMany: () => (calls.push('many'), true),
			...over,
		};
		return { calls, ...useEditKeys(o) };
	};
	const key = (over: Record<string, unknown>) => ({ key: 'A', shiftKey: true, target: { tagName: 'DIV' }, preventDefault: vi.fn(), ...over }) as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };

	it('calls what the page gave it and swallows the key', () => {
		const { calls, onKeydown } = make();
		const events = [key({}), key({ key: 'z', shiftKey: false, ctrlKey: true }), key({ key: 'Z', ctrlKey: true }), key({ key: 'Delete', shiftKey: false }), key({ key: 'Delete', shiftKey: false, ctrlKey: true }), key({ key: 'D' }), key({ key: 'd', shiftKey: true, ctrlKey: true })];
		events.forEach(onKeydown);
		expect(calls).toEqual(['add 5,6', 'undo', 'redo', 'remove', 'dissolve', 'duplicate', 'many']);
		for (const e of events) expect(e.preventDefault).toHaveBeenCalled();
	});

	it('leaves the key to the browser when there was nothing to act on', () => {
		const { onKeydown } = make({ remove: () => false, dissolve: () => false, duplicate: () => false, duplicateMany: () => false });
		for (const e of [key({ key: 'Backspace', shiftKey: false }), key({ key: 'd', shiftKey: false, ctrlKey: true }), key({ key: 'D', ctrlKey: true })]) {
			onKeydown(e);
			expect(e.preventDefault).not.toHaveBeenCalled();
		}
	});

	it('does nothing outside edit mode, in a field, or with a menu open', () => {
		let editing = false;
		let blocked = false;
		const { calls, onKeydown } = make({ editing: () => editing, blocked: () => blocked });
		onKeydown(key({}));
		editing = true;
		onKeydown(key({ target: { tagName: 'INPUT' } }));
		blocked = true;
		onKeydown(key({}));
		expect(calls).toEqual([]);
	});
});
