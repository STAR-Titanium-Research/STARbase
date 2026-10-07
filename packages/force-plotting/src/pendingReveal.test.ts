import { describe, expect, it } from 'vitest';
import { createPendingReveal } from './pendingReveal';

describe('createPendingReveal', () => {
	it('starts empty', () => {
		const p = createPendingReveal();
		expect(p.held).toBe(false);
		expect(p.take()).toBeNull();
	});
	it('holds a time until it is taken, then forgets it', () => {
		const p = createPendingReveal();
		p.hold(1.5);
		expect(p.held).toBe(true);
		expect(p.take()).toBe(1.5);
		expect(p.held).toBe(false);
		expect(p.take()).toBeNull();
	});
	it('keeps only the latest request, including t = 0', () => {
		const p = createPendingReveal();
		p.hold(1); p.hold(0);
		expect(p.held).toBe(true);   // 0 is a time, not "empty"
		expect(p.take()).toBe(0);
	});
	it('drops a held request', () => {
		const p = createPendingReveal();
		p.hold(2);
		p.drop();
		expect(p.held).toBe(false);
		expect(p.take()).toBeNull();
	});
});
