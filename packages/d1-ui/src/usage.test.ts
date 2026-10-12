import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDEX_DEFS } from './index/indexConfig';
import {
	DISMISSED_KEY, PAGES, PAGE_KEYS, RECORD_COLLECTIONS, SUGGESTED_PAGES, createRepeatFilter, mergeWithSuggestions, pageEntry, pageTarget,
	pinEntry, readDismissed, recordEntries, recordRequest, recordTarget, removeEntry, restoreEntry, revertPin, routeTarget, splitRecordTarget,
	suggestedPageEntries, withoutDismissed, writeDismissed, type UsageEntry,
} from './usage';

const here = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = join(here, '..', '..', '..', 'core', 'extensions', 'd1-usage', 'index.js');
const S1 = '11111111-aaaa-4aaa-8aaa-000000000001';

// The endpoint's literal lists, read as text (the endpoint is plain ESM JS in another package).
function endpointList(name: string): string[] {
	const src = readFileSync(ENDPOINT, 'utf8');
	const block = src.match(new RegExp(`export const ${name} = (?:new Set\\()?\\[([\\s\\S]*?)\\]`));
	if (!block) throw new Error(`${name} not found in ${ENDPOINT}`);
	return [...block[1].matchAll(/^\s*'([^']+)',\s*$/gm)].map((m) => m[1]);
}

describe('the kit and the endpoint agree on the keys', () => {
	it('PAGE_KEYS is the endpoint list, in the same order', () => {
		const theirs = endpointList('PAGE_KEYS');
		expect(theirs.length).toBeGreaterThan(20);
		expect([...PAGE_KEYS]).toEqual(theirs);
	});

	it('RECORD_COLLECTIONS is the endpoint list', () => {
		expect([...RECORD_COLLECTIONS]).toEqual(endpointList('RECORD_COLLECTIONS'));
	});

	it('every key has a label and a route, and every index page has a key', () => {
		for (const key of PAGE_KEYS) expect(PAGES[key], key).toBeTruthy();
		for (const def of INDEX_DEFS) expect(PAGE_KEYS, def.slug).toContain(def.slug);
		expect(Object.keys(PAGES).sort()).toEqual([...PAGE_KEYS].sort());
	});

	it('every suggestion is a known page', () => {
		for (const key of SUGGESTED_PAGES) expect(PAGE_KEYS).toContain(key);
	});
});

describe('pageTarget', () => {
	it('maps the Explorer pages, dashboards and quick-action forms to their keys', () => {
		expect(pageTarget('/home/samples')).toBe('samples');
		expect(pageTarget('/home/fast-recipes')).toBe('fast-recipes');
		expect(pageTarget('/home/projects')).toBe('projects');
		expect(pageTarget('/home/people')).toBe('people');
		expect(pageTarget('/d1-force-dashboard')).toBe('force-dashboard');
		expect(pageTarget('/d1-fast-dashboard')).toBe('fast-dashboard');
		expect(pageTarget('/content/physical_samples/+')).toBe('action:register-sample');
		expect(pageTarget('/content/manufacturing_operations/+')).toBe('action:log-operation');
		expect(pageTarget('/d1-report/labels')).toBe('action:print-labels');
	});

	it('ignores the query, a trailing slash and the /admin base', () => {
		expect(pageTarget('/home/samples?bookmark=3&q=A-1')).toBe('samples');
		expect(pageTarget('/home/samples/')).toBe('samples');
		expect(pageTarget('/admin/home/tests#top')).toBe('tests');
	});

	it('is null for Home, record pages, unknown slugs, the Data Studio and the actions as page keys', () => {
		for (const p of ['/home', '/home/', '/home/register-sample', '/home/nope', `/home/samples/${S1}`, '/content/physical_samples', `/content/physical_samples/${S1}`, '/report-bug', '', '/']) {
			expect(pageTarget(p), p).toBeNull();
		}
		// A slug that is a key with a colon or a dashboard id is not a /home/<slug> page.
		expect(pageTarget('/home/action:log-operation')).toBeNull();
		expect(pageTarget('/home/force-dashboard')).toBeNull();
	});
});

describe('recordTarget', () => {
	it('builds collection:id for the seven collections with a uuid id', () => {
		expect(recordTarget('physical_samples', S1)).toBe(`physical_samples:${S1}`);
		expect(recordTarget('people', S1.toUpperCase())).toBe(`people:${S1}`);
		for (const c of RECORD_COLLECTIONS) expect(recordTarget(c, S1), c).toBe(`${c}:${S1}`);
	});

	it('is null for another collection or an id the endpoint would refuse', () => {
		expect(recordTarget('tools', S1)).toBeNull();
		expect(recordTarget('physical_samples', '')).toBeNull();
		expect(recordTarget('physical_samples', null)).toBeNull();
		expect(recordTarget('physical_samples', undefined)).toBeNull();
		expect(recordTarget('physical_samples', 'abc')).toBeNull();
		expect(recordTarget('physical_samples', 0)).toBeNull();
		expect(recordTarget('equipment', 12)).toBeNull();
		expect(recordTarget('physical_samples', 123)).toBeNull();
		expect(recordTarget('physical_samples', `${S1}:x`)).toBeNull();
	});
});

describe('routeTarget', () => {
	it('is a page ping for a page and a record ping for a record page', () => {
		expect(routeTarget('/home/samples')).toEqual({ kind: 'page', target: 'samples' });
		expect(routeTarget(`/home/samples/${S1}`)).toEqual({ kind: 'record', target: `physical_samples:${S1}` });
		expect(routeTarget(`/home/operations/${S1}?x=1`)).toEqual({ kind: 'record', target: `manufacturing_operations:${S1}` });
		expect(routeTarget(`/home/tests/${S1}`)).toEqual({ kind: 'record', target: `test_sessions:${S1}` });
		expect(routeTarget(`/home/campaigns/${S1}`)).toEqual({ kind: 'record', target: `campaigns:${S1}` });
		expect(routeTarget(`/home/projects/${S1}`)).toEqual({ kind: 'record', target: `projects:${S1}` });
	});

	it('counts an equipment drawer (?open=<uuid>) as a visit to that item, and only that', () => {
		expect(routeTarget(`/home/equipment?open=${S1}`)).toEqual({ kind: 'record', target: `equipment:${S1}` });
		expect(routeTarget(`/home/equipment?q=x&open=${S1}#top`)).toEqual({ kind: 'record', target: `equipment:${S1}` });
		expect(routeTarget('/home/equipment?open=12')).toEqual({ kind: 'page', target: 'equipment' });
		expect(routeTarget('/home/equipment')).toEqual({ kind: 'page', target: 'equipment' });
		expect(routeTarget(`/home/tools?open=${S1}`)).toEqual({ kind: 'page', target: 'tools' });
		expect(routeTarget(`/home/people?open=${S1}`)).toEqual({ kind: 'page', target: 'people' });
	});

	it('is null for anything else', () => {
		for (const p of ['/home', '/home/samples/not-an-id', '/home/tools/' + S1, '/home/samples/%E0%A4%A', '/users/me', `/home/samples/${S1}/extra`]) {
			expect(routeTarget(p), p).toBeNull();
		}
	});
});

describe('createRepeatFilter', () => {
	it('lets a target through once per window, each target on its own', () => {
		let t = 1_000;
		const send = createRepeatFilter(600_000, () => t);
		expect(send('samples')).toBe(true);
		expect(send('samples')).toBe(false);
		expect(send('operations')).toBe(true);
		t += 599_999;
		expect(send('samples')).toBe(false);
		t += 1;
		expect(send('samples')).toBe(true);
		expect(send('samples')).toBe(false);
	});

	it('counts the window from the last send, not from a swallowed repeat', () => {
		let t = 0;
		const send = createRepeatFilter(10, () => t);
		expect(send('a')).toBe(true);
		t = 9;
		expect(send('a')).toBe(false);
		t = 10;
		expect(send('a')).toBe(true);
	});

	it('defaults to ten minutes', () => {
		const real = Date.now;
		let t = 5_000_000;
		Date.now = () => t;
		try {
			const send = createRepeatFilter();
			expect(send('x')).toBe(true);
			t += 9 * 60_000;
			expect(send('x')).toBe(false);
			t += 60_000;
			expect(send('x')).toBe(true);
		} finally {
			Date.now = real;
		}
	});
});

describe('createRepeatFilter peek, mark and unmark', () => {
	it('peek does not mark, mark does, and unmark lets the next try through', () => {
		let t = 0;
		const send = createRepeatFilter(100, () => t);
		expect(send.peek('a')).toBe(true);
		expect(send.peek('a')).toBe(true);
		send.mark('a');
		expect(send.peek('a')).toBe(false);
		expect(send('a')).toBe(false);
		send.unmark('a');
		expect(send.peek('a')).toBe(true);
		send.mark('a');
		t = 100;
		expect(send.peek('a')).toBe(true);
	});
});

describe('mergeWithSuggestions', () => {
	const real = (target: string) => ({ target, label: target });
	const sug = (target: string) => ({ target, label: target });

	it('fills a short list with flagged suggestions up to n', () => {
		const out = mergeWithSuggestions([real('a')], [sug('s1'), sug('s2'), sug('s3')], 3);
		expect(out.map((i) => i.target)).toEqual(['a', 's1', 's2']);
		expect(out.map((i) => i.suggested)).toEqual([undefined, true, true]);
	});

	it('shows only suggestions for no history, and none once there are n real items', () => {
		expect(mergeWithSuggestions([], [sug('s1'), sug('s2')], 6).every((i) => i.suggested)).toBe(true);
		expect(mergeWithSuggestions([real('a'), real('b')], [sug('s1')], 2).map((i) => i.target)).toEqual(['a', 'b']);
	});

	it('keeps every real item even beyond n, and skips a suggestion already in the list', () => {
		const items = ['a', 'b', 'c', 'd'].map(real);
		expect(mergeWithSuggestions(items, [sug('s1')], 2)).toHaveLength(4);
		expect(mergeWithSuggestions([real('s1')], [sug('s1'), sug('s2')], 3).map((i) => i.target)).toEqual(['s1', 's2']);
	});

	it('does not change its inputs', () => {
		const items = [real('a')];
		mergeWithSuggestions(items, [sug('s')], 3);
		expect(items).toEqual([{ target: 'a', label: 'a' }]);
	});
});

describe('page entries', () => {
	it('names a page and flags the print labels action as a new tab', () => {
		expect(pageEntry('samples', true)).toEqual({ target: 'samples', label: 'Samples', to: '/home/samples', pinned: true, newTab: undefined });
		expect(pageEntry('action:print-labels', false)?.newTab).toBe(true);
		expect(pageEntry('home', false)).toBeNull();
	});

	it('suggests the plain Samples page, not a saved view', () => {
		const labels = suggestedPageEntries().map((e) => e.label);
		expect(labels).toEqual(['Samples', 'Log an operation', 'Register a sample', 'Operations']);
	});
});

describe('records', () => {
	it('asks for the used ids of one collection in a single request', () => {
		const req = recordRequest('physical_samples', [S1, 'b', '123']);
		expect(req).not.toBeNull();
		expect(JSON.parse(req!.filter)).toEqual({ sample_id: { _in: [S1] } });
		expect(req!.fields).toContain('sample_code');
		expect(req!.limit).toBe(1);
		expect(recordRequest('physical_samples', [])).toBeNull();
		expect(recordRequest('physical_samples', ['123', 'x'])).toBeNull();
		expect(recordRequest('tools', [S1])).toBeNull();
	});

	it('labels each collection the way the finder and the lists do', () => {
		const used = (c: string) => [{ target: `${c}:${S1}`, pinned: false }];
		const one = (c: string, row: Record<string, unknown>) => recordEntries(c, [row], used(c))[0];
		expect(one('physical_samples', { sample_id: S1, sample_code: 'S-1' })).toMatchObject({ label: 'S-1', to: `/home/samples/${S1}` });
		expect(one('manufacturing_operations', { operation_id: S1, pass_code: '', operation_sequence: 2, sample_id: { sample_code: 'S-1' } })).toMatchObject({ label: 'S-1 · step 2', to: `/home/operations/${S1}` });
		expect(one('test_sessions', { session_id: S1, test_code: 'T-9' })).toMatchObject({ label: 'T-9', to: `/home/tests/${S1}` });
		expect(one('campaigns', { campaign_id: S1, campaign_code: null, name: 'Turning study' })).toMatchObject({ label: 'Turning study' });
		expect(one('projects', { project_id: S1, project_code: 'P1' })).toMatchObject({ label: 'P1', to: `/home/projects/${S1}` });
		expect(one('people', { person_id: S1, full_name: 'Jo Smith' })).toMatchObject({ label: 'Jo Smith', to: '/home/people?q=Jo%20Smith' });
		expect(one('equipment', { equipment_id: S1, equipment_code: 'EQ-1', equipment_name: 'NLX 2500' })).toMatchObject({ label: 'NLX 2500', to: `/home/equipment?open=${S1}` });
	});

	it('keeps the endpoint order and pins, and drops a record whose row did not come back', () => {
		const used = [
			{ target: `physical_samples:${S1}`, pinned: true },
			{ target: 'physical_samples:22222222-aaaa-4aaa-8aaa-000000000002', pinned: false },
			{ target: 'physical_samples:33333333-aaaa-4aaa-8aaa-000000000003', pinned: false },
		];
		const rows = [
			{ sample_id: '33333333-aaaa-4aaa-8aaa-000000000003', sample_code: 'S-3' },
			{ sample_id: S1.toUpperCase(), sample_code: 'S-1' },
		];
		const out = recordEntries('physical_samples', rows, used);
		expect(out.map((e) => [e.label, e.pinned])).toEqual([['S-1', true], ['S-3', false]]);
		expect(recordEntries('physical_samples', [], used)).toEqual([]);
		expect(recordEntries('tools', rows, used)).toEqual([]);
	});

	it('splits a target', () => {
		expect(splitRecordTarget(`people:${S1}`)).toEqual({ collection: 'people', id: S1 });
		expect(splitRecordTarget('samples')).toBeNull();
		expect(splitRecordTarget(`tools:${S1}`)).toBeNull();
	});
});

describe('list changes revert one entry, never the whole list', () => {
	const e = (target: string, pinned = false): UsageEntry => ({ target, label: target, to: '/x', pinned });
	const names = (l: UsageEntry[]) => l.map((x) => `${x.target}${x.pinned ? '*' : ''}`);

	it('pinEntry pins in place, adds a suggestion as a real entry, and sorts pinned first', () => {
		expect(names(pinEntry([e('a'), e('b')], e('b'), true))).toEqual(['b*', 'a']);
		const added = pinEntry([e('a')], { ...e('s'), suggested: true }, true);
		expect(names(added)).toEqual(['s*', 'a']);
		expect(added[0].suggested).toBeUndefined();
	});

	it('a failed pin of A does not bring back a hidden B', () => {
		const before = [e('a'), e('b')];
		const afterPin = pinEntry(before, e('a'), true);
		const { list: afterHide } = removeEntry(afterPin, 'b');
		expect(names(revertPin(afterHide, 'a', e('a')))).toEqual(['a']);
	});

	it('reverting a pin that added a suggestion removes it; one already hidden stays hidden', () => {
		expect(names(revertPin([e('s', true), e('a')], 's', null))).toEqual(['a']);
		expect(names(revertPin([e('a')], 'gone', e('gone')))).toEqual(['a']);
	});

	it('a failed hide of A restores only A, and leaves a later pin of C alone', () => {
		const { list, index } = removeEntry([e('a'), e('b'), e('c')], 'a');
		expect(index).toBe(0);
		const later = pinEntry(list, e('c'), true);
		expect(names(restoreEntry(later, e('a'), index))).toEqual(['c*', 'a', 'b']);
	});

	it('restoreEntry clamps the place and does not duplicate', () => {
		expect(names(restoreEntry([e('b')], e('a'), 9))).toEqual(['b', 'a']);
		expect(names(restoreEntry([e('a'), e('b')], e('a'), 0))).toEqual(['a', 'b']);
		expect(removeEntry([e('a')], 'zzz')).toEqual({ list: [e('a')], index: -1 });
	});
});

describe('dismissed suggestions', () => {
	const fake = (initial?: string) => {
		const data = new Map<string, string>(initial === undefined ? [] : [[DISMISSED_KEY, initial]]);
		return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
	};

	it('round-trips through storage under d1.usage.dismissed', () => {
		const store = fake();
		writeDismissed(new Set(['samples', 'operations']), store);
		expect(DISMISSED_KEY).toBe('d1.usage.dismissed');
		expect(store.data.get('d1.usage.dismissed')).toBe('["samples","operations"]');
		expect([...readDismissed(store)]).toEqual(['samples', 'operations']);
	});

	it('works without storage: junk, missing, throwing', () => {
		expect(readDismissed(fake('not json')).size).toBe(0);
		expect(readDismissed(fake('{"a":1}')).size).toBe(0);
		expect([...readDismissed(fake('["a",3,null]'))]).toEqual(['a']);
		expect(readDismissed(null).size).toBe(0);
		const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
		expect(readDismissed(boom).size).toBe(0);
		expect(() => writeDismissed(new Set(['a']), boom)).not.toThrow();
		expect(() => writeDismissed(new Set(['a']), null)).not.toThrow();
	});

	it('filters suggestions by the dismissed set', () => {
		const sug = [{ target: 'samples' }, { target: 'operations' }];
		expect(withoutDismissed(sug, new Set(['samples']))).toEqual([{ target: 'operations' }]);
	});
});
