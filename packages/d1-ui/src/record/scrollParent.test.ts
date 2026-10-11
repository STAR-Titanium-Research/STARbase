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
