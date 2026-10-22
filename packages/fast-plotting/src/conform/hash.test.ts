import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureText } from './__fixtures__/load';
import { sha256Hex, sha256HexSync } from './hash';

const bytes = new TextEncoder().encode(fixtureText);
const viaSubtle = async (b: Uint8Array): Promise<string> =>
	[...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');

afterEach(() => vi.unstubAllGlobals());

describe('sha256HexSync', () => {
	it('matches the standard test vectors', () => {
		expect(sha256HexSync(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(sha256HexSync(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(sha256HexSync(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
			.toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
	});
	it('equals crypto.subtle on the fixture bytes and on every padding boundary', async () => {
		expect(sha256HexSync(bytes)).toBe(await viaSubtle(bytes));
		for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
			const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
			expect(sha256HexSync(b), `length ${n}`).toBe(await viaSubtle(b));
		}
	});
});

describe('sha256Hex', () => {
	it('uses crypto.subtle when the page has it', async () => {
		expect(await sha256Hex(bytes)).toBe(await viaSubtle(bytes));
	});
	it('falls back to plain JavaScript on a page with no crypto.subtle (plain HTTP), giving the same hash', async () => {
		const expected = await viaSubtle(bytes);
		vi.stubGlobal('crypto', { randomUUID: () => 'x' });
		expect(globalThis.crypto.subtle).toBeUndefined();
		expect(await sha256Hex(bytes)).toBe(expected);
		expect(await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer)).toBe(expected);
	});
	it('hashes a view onto part of a buffer, not the whole buffer', async () => {
		const part = bytes.subarray(10, 200);
		expect(await sha256Hex(part)).toBe(await viaSubtle(part.slice()));
	});
});
