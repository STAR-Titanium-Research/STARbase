import { describe, expect, it } from 'vitest';
import { createActivationQueue, createOpGuard } from './opGuard';

describe('createOpGuard', () => {
	it('is live while the same op stays open', () => {
		let open: string | null = 'A';
		const g = createOpGuard(() => open);
		expect(g.begin('A')()).toBe(true);
	});
	it('goes stale when another op is opened, even with no cancelAll()', () => {
		let open: string | null = 'A';
		const g = createOpGuard(() => open);
		const live = g.begin('A');
		open = 'B';
		expect(live()).toBe(false);
	});
	it('cancelAll() stales every guard, including for the same op, and new ones start live', () => {
		const g = createOpGuard(() => 'A');
		const a = g.begin('A'), b = g.begin('A');
		g.cancelAll();
		expect(a()).toBe(false);
		expect(b()).toBe(false);
		expect(g.begin('A')()).toBe(true);
	});
	it('a missing op id is never live', () => {
		const g = createOpGuard(() => null);
		expect(g.begin(null)()).toBe(false);
	});

	// The review scenario: bake on op A, open op B, the bake's poll lands.
	it('a poll started for op A never writes into op B', async () => {
		let open = 'A';
		const detail: Record<string, string> = { A: 'raw', B: 'raw' };
		const g = createOpGuard(() => open);
		let release!: () => void;
		const poll = (async () => {
			const live = g.begin(open);
			await new Promise<void>((r) => { release = r; });
			if (!live()) return;
			detail[open] = 'A-baked';
		})();
		open = 'B'; g.cancelAll();
		release(); await poll;
		expect(detail).toEqual({ A: 'raw', B: 'raw' });
	});
});

describe('createActivationQueue', () => {
	it('runs immediately while active', () => {
		const q = createActivationQueue();
		let n = 0;
		q.whenActive(() => n++);
		expect(n).toBe(1);
	});
	it('holds work while deactivated and runs it, in order, on activate', () => {
		const q = createActivationQueue();
		const log: string[] = [];
		q.deactivate();
		q.whenActive(() => log.push('a')); q.whenActive(() => log.push('b'));
		expect(log).toEqual([]);
		q.activate();
		expect(log).toEqual(['a', 'b']);
		q.whenActive(() => log.push('c'));   // active again: immediate
		expect(log).toEqual(['a', 'b', 'c']);
	});
	it('clear() drops queued work (unmount)', () => {
		const q = createActivationQueue();
		let n = 0;
		q.deactivate(); q.whenActive(() => n++); q.clear(); q.activate();
		expect(n).toBe(0);
	});

	// The coordinator's scenario: start a bake, visit the Record page, come back.
	it('a poll that finishes while deactivated applies detail at once and defers the GL work to activate', async () => {
		let open = 'A';
		const detail: Record<string, string> = { A: 'raw' };
		const guard = createOpGuard(() => open);
		const q = createActivationQueue();
		const glWork: string[] = [];
		let finish!: () => void;
		const bake = (async () => {
			const live = guard.begin(open);
			await new Promise<void>((r) => { finish = r; });
			if (!live()) return;
			detail.A = 'baked';
			q.whenActive(() => { if (live()) glWork.push('loadFrm A'); });
		})();
		q.deactivate();            // operator goes to the Record page; the guard is NOT cancelled
		finish(); await bake;
		expect(detail.A).toBe('baked');
		expect(glWork).toEqual([]);
		q.activate();              // back on /plot, same op
		expect(glWork).toEqual(['loadFrm A']);
	});
	it('deferred GL work is dropped if the op changed while deactivated', async () => {
		let open = 'A';
		const guard = createOpGuard(() => open);
		const q = createActivationQueue();
		const glWork: string[] = [];
		const live = guard.begin('A');
		q.deactivate();
		q.whenActive(() => { if (live()) glWork.push('loadFrm A'); });
		open = 'B'; guard.cancelAll();
		q.activate();
		expect(glWork).toEqual([]);
	});
});
