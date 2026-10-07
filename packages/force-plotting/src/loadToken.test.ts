import { describe, expect, it } from 'vitest';
import { createLoadToken } from './loadToken';

describe('createLoadToken', () => {
	it('only the newest load is current', () => {
		const t = createLoadToken();
		const a = t.next(), b = t.next();
		expect(t.isCurrent(a)).toBe(false);
		expect(t.isCurrent(b)).toBe(true);
	});
	it('cancel makes every in-flight load stale', () => {
		const t = createLoadToken();
		const a = t.next();
		t.cancel();
		expect(t.isCurrent(a)).toBe(false);
	});

	// The scenario from the review: op A downloads slowly, op B finishes first, then A lands.
	it('a slow older load that lands last applies nothing', async () => {
		const t = createLoadToken();
		const applied: string[] = [];
		const gates: Record<string, () => void> = {};
		const load = async (id: string) => {
			const mine = t.next();
			await new Promise<void>((r) => { gates[id] = r; });
			if (!t.isCurrent(mine)) return;
			applied.push(id);
		};
		const a = load('A'), b = load('B');
		gates.B(); await b;
		gates.A(); await a;
		expect(applied).toEqual(['B']);
	});

	// DiagOctreeView / FrmOctree: a point cloud that finishes loading after unmount (cancel) or
	// after a newer load started must be disposed by the load that created it, not leaked.
	it('a load that lands after cancel() or a newer load disposes what it created', async () => {
		const t = createLoadToken();
		const disposed: string[] = [], shown: string[] = [];
		const gates: Record<string, () => void> = {};
		const load = async (id: string) => {
			const mine = t.next();
			await new Promise<void>((r) => { gates[id] = r; });
			const cloud = { id, dispose: () => disposed.push(id) };
			if (!t.isCurrent(mine)) { cloud.dispose(); return; }
			shown.push(id);
		};
		const a = load('A'), b = load('B');   // B supersedes A
		gates.A(); await a;
		t.cancel();                            // unmount while B is still loading
		gates.B(); await b;
		expect(shown).toEqual([]);
		expect(disposed).toEqual(['A', 'B']);
	});
});
