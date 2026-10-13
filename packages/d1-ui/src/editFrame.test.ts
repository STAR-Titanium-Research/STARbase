import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { editFrameUrl, editMessage, frameReporter, frameTell, isEditMessage, loadTargetOrigin, NEW_ITEM_ID, readEditMessage, targetOriginFrom } from './editFrame';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const STAR = 'https://starbase.tail54eeb6.ts.net';

describe('editFrameUrl', () => {
	it("is d1-server's form-only page for the record, and carries no origin of its own", () => {
		expect(editFrameUrl(`${D1}/`, 'physical_samples', 'abc')).toBe(`${D1}/admin/d1-edit/physical_samples/abc`);
		expect(editFrameUrl(D1, 'physical_samples', 'abc')).not.toContain('parent');
	});
	it('encodes an id with a slash, a space or a percent, and the frame gets the same id back (Review Focus 4)', () => {
		const url = editFrameUrl(D1, 'physical_samples', 'a/b c%');
		expect(url).toBe(`${D1}/admin/d1-edit/physical_samples/a%2Fb%20c%25`);
		const segment = new URL(url).pathname.split('/').pop()!;
		expect(decodeURIComponent(segment)).toBe('a/b c%');
	});
	it("keeps '+' (a new record) as Data Studio writes it", () => {
		expect(editFrameUrl(D1, 'projects', NEW_ITEM_ID)).toBe(`${D1}/admin/d1-edit/projects/+`);
	});
});

describe('targetOriginFrom: where the frame may post, from GET /d1-links (STARBASE_URL)', () => {
	it("is the origin of d1-server's STARbase address", () => {
		expect(targetOriginFrom(`${STAR}/`)).toBe(STAR);
		expect(targetOriginFrom('https://starbase.example:5191/app')).toBe('https://starbase.example:5191');
		expect(targetOriginFrom('http://127.0.0.1:5190')).toBe('http://127.0.0.1:5190');
	});
	it('is null when the setting is missing or not an http(s) address', () => {
		for (const v of [null, undefined, '', '  ', 'javascript:alert(1)', 'not a url', 42, {}]) expect(targetOriginFrom(v), String(v)).toBeNull();
	});
});

describe('frameTell: the frame side of the origin check', () => {
	it("posts to STARbase at its exact origin, never '*'", () => {
		const postMessage = vi.fn();
		expect(frameTell({ postMessage }, STAR, editMessage('saved', 'physical_samples', 's1'))).toBe(true);
		expect(postMessage).toHaveBeenCalledWith(editMessage('saved', 'physical_samples', 's1'), STAR);
	});
	it('posts nothing without a target origin (STARBASE_URL unset, or /d1-links missing), or without a window', () => {
		const postMessage = vi.fn();
		expect(frameTell({ postMessage }, null, editMessage('saved', 'physical_samples', 's1'))).toBe(false);
		expect(frameTell(null, STAR, editMessage('saved', 'physical_samples', 's1'))).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});
});

describe('loadTargetOrigin: the frame learns STARbase from d1-server, GET /d1-links', () => {
	it("is the origin of the endpoint's starbaseUrl", async () => {
		const get = vi.fn().mockResolvedValue({ data: { starbaseUrl: `${STAR}/` } });
		expect(await loadTargetOrigin({ get })).toBe(STAR);
		expect(get).toHaveBeenCalledWith('/d1-links');
	});
	it('is null when STARBASE_URL is unset (the endpoint says null), garbage, or the request fails', async () => {
		expect(await loadTargetOrigin({ get: async () => ({ data: { starbaseUrl: null } }) })).toBeNull();
		expect(await loadTargetOrigin({ get: async () => ({ data: {} }) })).toBeNull();
		expect(await loadTargetOrigin({ get: async () => ({ data: { starbaseUrl: 'javascript:alert(1)' } }) })).toBeNull();
		expect(await loadTargetOrigin({ get: async () => ({}) })).toBeNull();
		expect(
			await loadTargetOrigin({
				get: async () => {
					throw new Error('404');
				},
			}),
		).toBeNull();
	});
});

describe('frameReporter: who the frame tells, and where', () => {
	const parent = { postMessage: vi.fn() };
	const opener = { postMessage: vi.fn() };
	const make = (framed: boolean, origin: string | null) => {
		parent.postMessage.mockClear();
		opener.postMessage.mockClear();
		return frameReporter({ framed, parent: () => parent, opener: () => opener, targetOrigin: () => origin, collection: 'physical_samples', id: () => 's1' });
	};

	it('framed: tells the framing page, at the origin d1-links gave, never the opener', () => {
		const tell = make(true, STAR);
		expect(tell('ready')).toBe(true);
		expect(parent.postMessage).toHaveBeenCalledWith(editMessage('ready', 'physical_samples', 's1'), STAR);
		expect(opener.postMessage).not.toHaveBeenCalled();
	});
	it('a new tab (not framed): tells window.opener, at the same origin', () => {
		const tell = make(false, STAR);
		tell('saved', 'new-1');
		expect(opener.postMessage).toHaveBeenCalledWith(editMessage('saved', 'physical_samples', 'new-1'), STAR);
		expect(parent.postMessage).not.toHaveBeenCalled();
	});
	it('posts nothing when d1-links gave no origin (unset, failed to load), framed or not', () => {
		expect(make(true, null)('saved')).toBe(false);
		expect(make(false, null)('saved')).toBe(false);
		expect(parent.postMessage).not.toHaveBeenCalled();
		expect(opener.postMessage).not.toHaveBeenCalled();
	});
	it('reads the origin when it tells, so one that arrives after mount is used', () => {
		let origin: string | null = null;
		const tell = frameReporter({ framed: true, parent: () => parent, opener: () => null, targetOrigin: () => origin, collection: 'c', id: () => '1' });
		parent.postMessage.mockClear();
		expect(tell('ready')).toBe(false);
		origin = STAR;
		expect(tell('ready')).toBe(true);
	});
	it("takes no origin from the page's own URL: a forged ?parent= changes nothing", async () => {
		// The page's URL never reaches loadTargetOrigin or frameReporter (neither takes one); with d1-links
		// unset the frame stays silent however its URL reads, and with it set the target is d1-links' origin.
		const forged = 'https://evil.example';
		const unset = await loadTargetOrigin({ get: async () => ({ data: { starbaseUrl: null } }) });
		expect(make(false, unset)('saved')).toBe(false);
		expect(opener.postMessage).not.toHaveBeenCalled();
		const real = await loadTargetOrigin({ get: async () => ({ data: { starbaseUrl: STAR } }) });
		make(false, real)('saved');
		expect(opener.postMessage).toHaveBeenCalledWith(expect.anything(), STAR);
		expect(opener.postMessage).not.toHaveBeenCalledWith(expect.anything(), forged);
	});
});

describe('the frame page (core/extensions/d1-edit-frame): a guard beside the behaviour tests above', () => {
	// The page itself has no test runner of its own (a Directus module); this pins where its origin comes from
	// and that the save logic is the shared one.
	const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
	const src = readFileSync(join(repo, 'core', 'extensions', 'd1-edit-frame', 'src', 'EditFramePage.vue'), 'utf8');

	it("learns the target origin through loadTargetOrigin (GET /d1-links), and ignores its own URL", () => {
		expect(src).toContain('loadTargetOrigin(');
		expect(src).toContain('frameReporter(');
		expect(src).not.toMatch(/location\.(search|href|hash)|URLSearchParams|parent=/);
	});
	it('posts only through the helpers', () => {
		expect(src).not.toMatch(/\.postMessage\(/);
	});
	it('shares the save, conflict and discard logic with EditDrawer (no copy)', () => {
		expect(src).toContain('useEditSession(');
		expect(src).not.toMatch(/versionChanged|buildPatch|saveErrors/);
	});
});

describe('readEditMessage (Review Focus 4)', () => {
	const frame = { name: 'the frame' };
	const expected = { origin: D1, source: frame, collection: 'physical_samples', id: 's1' };
	const ev = (data: unknown, origin = D1, source: unknown = frame) => ({ data, origin, source });

	it('accepts the frame telling about the record it was opened for', () => {
		expect(readEditMessage(ev(editMessage('saved', 'physical_samples', 's1')), expected)).toEqual(editMessage('saved', 'physical_samples', 's1'));
		expect(readEditMessage(ev(editMessage('ready', 'physical_samples', 's1')), expected)?.result).toBe('ready');
	});
	it('ignores another origin, another window, no window, another record and malformed data', () => {
		const ok = editMessage('saved', 'physical_samples', 's1');
		expect(readEditMessage(ev(ok, STAR), expected)).toBeNull();
		expect(readEditMessage(ev(ok, D1, { name: 'another tab' }), expected)).toBeNull();
		expect(readEditMessage(ev(ok, D1, null), { ...expected, source: null })).toBeNull();
		expect(readEditMessage(ev(editMessage('saved', 'projects', 's1')), expected)).toBeNull();
		expect(readEditMessage(ev(editMessage('saved', 'physical_samples', 's2')), expected)).toBeNull();
		for (const bad of [null, 'saved', { type: 'd1-edit', result: 'deleted', collection: 'physical_samples', id: 's1' }, { type: 'x', result: 'saved', collection: 'physical_samples', id: 's1' }]) {
			expect(readEditMessage(ev(bad), expected)).toBeNull();
		}
	});
	it("a new record ('+') comes back saved under its new id; cancelling keeps '+'", () => {
		const create = { ...expected, id: NEW_ITEM_ID };
		expect(readEditMessage(ev(editMessage('saved', 'physical_samples', 'new-1')), create)?.id).toBe('new-1');
		expect(readEditMessage(ev(editMessage('cancelled', 'physical_samples', NEW_ITEM_ID)), create)?.result).toBe('cancelled');
		expect(readEditMessage(ev(editMessage('cancelled', 'physical_samples', 'other')), create)).toBeNull();
	});
	it('isEditMessage checks the shape only', () => {
		expect(isEditMessage(editMessage('cancelled', 'c', '1'))).toBe(true);
		expect(isEditMessage({ type: 'd1-edit', result: 'saved', collection: 'c' })).toBe(false);
	});
});
