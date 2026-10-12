import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasPopoutMarker, queryWithPopoutMarker, withPopoutMarker } from './popoutWindow';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

describe('pop-out marker', () => {
	it('is added to the URL the opener builds, with or without a query', () => {
		expect(withPopoutMarker('/plot')).toBe('/plot?popout=1');
		expect(withPopoutMarker('/plot?focus=x')).toBe('/plot?focus=x&popout=1');
	});
	it('is read from the query string', () => {
		expect(hasPopoutMarker('?popout=1')).toBe(true);
		expect(hasPopoutMarker('?a=b&popout=1')).toBe(true);
		expect(hasPopoutMarker('')).toBe(false);
		expect(hasPopoutMarker('?popout=0')).toBe(false);
	});
	it('is put back on a navigation inside a pop-out, and never added to the main window', () => {
		expect(queryWithPopoutMarker(true, { focus: 'a' })).toEqual({ focus: 'a', popout: '1' });
		expect(queryWithPopoutMarker(true, { popout: '1' })).toBeNull();
		expect(queryWithPopoutMarker(false, {})).toBeNull();
	});
});

describe('wiring (source checks: the SFCs are not mounted in unit tests)', () => {
	it('AppShell opens pop-outs with the marker and hosts the rig tests in the main window only', () => {
		const shell = read('./AppShell.vue');
		expect(shell).toMatch(/window\.open\(appUrl\(withPopoutMarker\(to\)\)/);
		expect(shell).toMatch(/<RigTestHost v-if="!isPopoutWindow"/);
	});
	it('the router keeps the marker on every navigation inside a pop-out', () => {
		expect(read('./router.ts')).toMatch(/queryWithPopoutMarker\(isPopoutWindow/);
	});
});
