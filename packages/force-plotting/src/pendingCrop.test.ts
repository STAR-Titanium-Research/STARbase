import { describe, expect, it } from 'vitest';
import { createPendingCrop } from './pendingCrop';

describe('createPendingCrop', () => {
	it("survives the immediate apply and is consumed by the same operation's cache load", () => {
		const p = createPendingCrop();
		p.set('op1', [2, 9]);
		expect(p.peek('op1')).toEqual([2, 9]);   // applyViewState applies it ...
		expect(p.peek('op1')).toEqual([2, 9]);   // ... without clearing: the cache has not parsed yet
		expect(p.take('op1')).toEqual([2, 9]);   // onCloudLoaded re-applies it after re-seeding
		expect(p.take('op1')).toBeNull();        // then it is gone: later loads keep the user's edits
		expect(p.active).toBe(false);
	});

	it('is dropped, not applied, when another operation loads', () => {
		const p = createPendingCrop();
		p.set('op1', [2, 9]);
		expect(p.peek('op2')).toBeNull();
		expect(p.take('op2')).toBeNull();
		expect(p.take('op1')).toBeNull();
	});

	it('clear() drops it (operation change, or the user dragging a handle)', () => {
		const p = createPendingCrop();
		p.set('op1', [2, 9]);
		p.clear();
		expect(p.take('op1')).toBeNull();
	});

	it('ignores a missing operation id', () => {
		const p = createPendingCrop();
		p.set('op1', [2, 9]);
		expect(p.peek(undefined)).toBeNull();
		expect(p.take(null)).toBeNull();
	});
});
