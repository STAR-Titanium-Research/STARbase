import { describe, expect, it } from 'vitest';
import { linkActive, parseCollapsed } from './navState';

describe('parseCollapsed', () => {
	it('defaults to Inventory and Resources collapsed', () => {
		expect(parseCollapsed(null)).toEqual(['inventory', 'resources']);
		expect(parseCollapsed('not json')).toEqual(['inventory', 'resources']);
		expect(parseCollapsed('{"a":1}')).toEqual(['inventory', 'resources']);
		expect(parseCollapsed('[1,2]')).toEqual(['inventory', 'resources']);
	});

	it('reads what the user left, including everything open', () => {
		expect(parseCollapsed('["resources"]')).toEqual(['resources']);
		expect(parseCollapsed('[]')).toEqual([]);
	});
});

describe('linkActive', () => {
	it('lights an entry on its own page and on a record page under it', () => {
		expect(linkActive('/home/samples', '/home/samples', {})).toBe(true);
		expect(linkActive('/home/samples', '/home/samples/12', {})).toBe(true);
		expect(linkActive('/home/samples', '/home/operations', {})).toBe(false);
	});

	it('does not confuse a page with another that starts with the same letters', () => {
		expect(linkActive('/home/tools', '/home/tool-boxes', {})).toBe(false);
		expect(linkActive('/home/tests', '/home/tests/9', {})).toBe(true);
	});

	it('lights Home only on Home', () => {
		expect(linkActive('/home', '/home', {})).toBe(true);
		expect(linkActive('/home', '/home/samples', {})).toBe(false);
	});

	it('lights the bookmark entry, not its list, when a saved view is open', () => {
		const q = { bookmark: '3' };
		expect(linkActive('/home/samples?bookmark=3', '/home/samples', q)).toBe(true);
		expect(linkActive('/home/samples?bookmark=4', '/home/samples', q)).toBe(false);
		expect(linkActive('/home/samples', '/home/samples', q)).toBe(false);
		expect(linkActive('/home/samples?bookmark=3', '/home/samples', {})).toBe(false);
	});

	it('takes the first value when the query repeats a key', () => {
		expect(linkActive('/home/samples?bookmark=3', '/home/samples', { bookmark: ['3', '5'] })).toBe(true);
	});
});
