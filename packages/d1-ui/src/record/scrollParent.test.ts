import { describe, expect, it } from 'vitest';
import { findScrollParent } from './scrollParent';

interface Fake { name: string; overflowY: string; parentElement: Fake | null }
const el = (name: string, overflowY: string, parentElement: Fake | null = null): Fake => ({ name, overflowY, parentElement });
const style = (e: Fake) => ({ overflowY: e.overflowY });

describe('findScrollParent', () => {
	it('finds the nearest ancestor that scrolls vertically', () => {
		const outer = el('outer', 'scroll');
		const inner = el('inner', 'auto', outer);
		const root = el('root', 'visible', inner);
		expect(findScrollParent(root, style)?.name).toBe('inner');
	});
	it('does not count the starting element itself', () => {
		const top = el('top', 'auto');
		const root = el('root', 'auto', top);
		expect(findScrollParent(root, style)?.name).toBe('top');
	});
	it('skips hidden and visible overflow', () => {
		const root = el('root', 'visible', el('a', 'hidden', el('b', 'visible')));
		expect(findScrollParent(root, style)).toBeNull();
	});
});

describe('findScrollParent with a target', () => {
	it('skips a scroller that does not contain the target (the rail beside the sections)', () => {
		const page = el('page', 'auto');
		const rail = el('rail', 'auto', page);
		const nav = el('nav', 'visible', rail);
		const section = el('section', 'visible', page);
		const contains = (target: Fake) => (s: Fake) => {
			for (let e: Fake | null = target; e; e = e.parentElement) if (e === s) return true;
			return false;
		};
		expect(findScrollParent(nav, style)?.name).toBe('rail');
		expect(findScrollParent(nav, style, contains(section))?.name).toBe('page');
	});
});
