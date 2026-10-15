import { describe, expect, it, vi } from 'vitest';
import { isTyping, keyDecision, useEditKeys } from './useEditKeys';

const free = { typing: false, blocked: false };

describe('edit keys: Shift+A', () => {
	it('opens the Add menu', () => {
		expect(keyDecision({ key: 'A', shiftKey: true }, free)).toEqual({ do: 'add' });
		expect(keyDecision({ key: 'a', shiftKey: true }, free)).toEqual({ do: 'add' });
	});
	it('is not a plain A, nor with Ctrl, Cmd or Alt (those keep their meaning)', () => {
		expect(keyDecision({ key: 'a' }, free)).toBeNull();
		expect(keyDecision({ key: 'A', shiftKey: true, ctrlKey: true }, free)).toBeNull();
		expect(keyDecision({ key: 'A', shiftKey: true, metaKey: true }, free)).toBeNull();
		expect(keyDecision({ key: 'A', shiftKey: true, altKey: true }, free)).toBeNull();
	});
	it('is ignored while typing, and while a menu or the picker is open', () => {
		expect(keyDecision({ key: 'A', shiftKey: true }, { typing: true, blocked: false })).toBeNull();
		expect(keyDecision({ key: 'A', shiftKey: true }, { typing: false, blocked: true })).toBeNull();
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
	const key = (over: Record<string, unknown>) => ({ key: 'A', shiftKey: true, target: { tagName: 'DIV' }, preventDefault: vi.fn(), ...over }) as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };

	it('opens the menu at the pointer while a draft can be changed, and swallows the key', () => {
		const add = vi.fn();
		const { onKeydown } = useEditKeys({ editing: () => true, blocked: () => false, pointer: () => ({ x: 5, y: 6 }), add });
		const e = key({});
		onKeydown(e);
		expect(add).toHaveBeenCalledWith({ x: 5, y: 6 });
		expect(e.preventDefault).toHaveBeenCalled();
	});

	it('does nothing outside edit mode, in a field, or with a menu open', () => {
		const add = vi.fn();
		let editing = false;
		let blocked = false;
		const { onKeydown } = useEditKeys({ editing: () => editing, blocked: () => blocked, pointer: () => ({ x: 0, y: 0 }), add });
		onKeydown(key({}));
		editing = true;
		onKeydown(key({ target: { tagName: 'INPUT' } }));
		blocked = true;
		onKeydown(key({}));
		expect(add).not.toHaveBeenCalled();
	});
});
