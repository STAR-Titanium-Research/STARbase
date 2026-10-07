import { describe, expect, it } from 'vitest';
import { useListNav } from './listNav';

function setup(items: string[]) {
	const picked: string[] = [];
	const nav = useListNav(() => items, (it) => picked.push(it));
	return { nav, picked };
}

describe('useListNav', () => {
	it('picks the first item on Enter when nothing is highlighted (the old behaviour)', () => {
		const { nav, picked } = setup(['a', 'b', 'c']);
		expect(nav.pickActive()).toBe(true);
		expect(picked).toEqual(['a']);
	});

	it('moves down from nothing to the first item, then clamps at the last', () => {
		const { nav, picked } = setup(['a', 'b', 'c']);
		nav.move(1);
		expect(nav.active.value).toBe(0);
		nav.move(1); nav.move(1); nav.move(1);
		expect(nav.active.value).toBe(2);
		nav.pickActive();
		expect(picked).toEqual(['c']);
	});

	it('moves up from nothing to the last item, then clamps at the first', () => {
		const { nav } = setup(['a', 'b', 'c']);
		nav.move(-1);
		expect(nav.active.value).toBe(2);
		nav.move(-1); nav.move(-1); nav.move(-1);
		expect(nav.active.value).toBe(0);
	});

	it('does nothing on an empty list', () => {
		const { nav, picked } = setup([]);
		nav.move(1);
		expect(nav.active.value).toBe(-1);
		expect(nav.pickActive()).toBe(false);
		expect(picked).toEqual([]);
	});

	it('falls back to the first item when the list shrank under the highlight', () => {
		const items = ['a', 'b', 'c'];
		const picked: string[] = [];
		const nav = useListNav(() => items, (it) => picked.push(it));
		nav.move(1); nav.move(1); nav.move(1);
		items.splice(1); // new, shorter results arrived before reset()
		nav.pickActive();
		expect(picked).toEqual(['a']);
	});

	it('reset clears the highlight', () => {
		const { nav } = setup(['a', 'b']);
		nav.move(1);
		nav.reset();
		expect(nav.active.value).toBe(-1);
	});

	it('skips disabled items when moving, in both directions', () => {
		const items = ['a', 'b', 'c', 'd'];
		const nav = useListNav(() => items, () => {}, undefined, (it) => it === 'b' || it === 'd');
		nav.move(1);
		expect(nav.active.value).toBe(0);
		nav.move(1);
		expect(nav.active.value).toBe(2);   // jumped over b
		nav.move(1);
		expect(nav.active.value).toBe(2);   // d is disabled: stays on the last enabled item
		nav.move(-1);
		expect(nav.active.value).toBe(0);
	});

	it('starts from the last enabled item when moving up from nothing', () => {
		const nav = useListNav(() => ['a', 'b', 'c'], () => {}, undefined, (it) => it === 'c');
		nav.move(-1);
		expect(nav.active.value).toBe(1);
	});

	it('Enter with nothing highlighted picks the first enabled item, never a disabled one', () => {
		const picked: string[] = [];
		const nav = useListNav(() => ['a', 'b'], (it) => picked.push(it), undefined, (it) => it === 'a');
		expect(nav.pickActive()).toBe(true);
		expect(picked).toEqual(['b']);
	});

	it('does nothing when every item is disabled', () => {
		const picked: string[] = [];
		const nav = useListNav(() => ['a'], (it) => picked.push(it), undefined, () => true);
		nav.move(1);
		expect(nav.active.value).toBe(-1);
		expect(nav.pickActive()).toBe(false);
	});
});
