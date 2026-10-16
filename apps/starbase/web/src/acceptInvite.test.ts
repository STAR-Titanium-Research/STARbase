import { describe, expect, it } from 'vitest';
import { acceptInvite, policyChecks, tokenEmail, tokenFrom } from './acceptInvite';
import { createApi } from './api';
import { fakeServer, type Reply } from './testing/fakeServer';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const fail = (status: number, code: string, message: string): Reply => ({ status, data: { errors: [{ message, extensions: { code } }] } });

function accept(reply: Reply) {
	const api = createApi(D1);
	let sent: { url?: string; body?: unknown; noGuard?: boolean } = {};
	const calls = fakeServer(api, (key, cfg) => {
		sent = { url: key, body: JSON.parse(cfg.data), noGuard: cfg.sbNoGuard };
		return reply;
	});
	return { api, calls, sent: () => sent };
}

// A JWT-shaped string: only the middle segment matters to the client (it never checks the signature).
const jwtWith = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('acceptInvite', () => {
	it('ok on 204, posting the token and password outside the session guard', async () => {
		const { api, sent } = accept(204);
		expect(await acceptInvite(api, 'tok', 'Pw1!')).toBe('ok');
		expect(sent()).toEqual({ url: 'POST /users/invite/accept', body: { token: 'tok', password: 'Pw1!' }, noGuard: true });
	});

	it('expired on TOKEN_EXPIRED', async () => {
		const { api } = accept(fail(401, 'TOKEN_EXPIRED', 'Token expired.'));
		expect(await acceptInvite(api, 't', 'p')).toBe('expired');
	});

	it('invalid on INVALID_TOKEN, INVALID_INVITE (already used), a wrong scope (FORBIDDEN) and a token the payload check refuses', async () => {
		for (const r of [
			fail(403, 'INVALID_TOKEN', 'Invalid token.'),
			fail(400, 'INVALID_INVITE', 'This invite is no longer valid.'),
			fail(403, 'FORBIDDEN', 'You don\'t have permission to access this.'),
			fail(400, 'INVALID_PAYLOAD', 'Invalid payload. "token" is not allowed to be empty.'),
		]) {
			expect(await acceptInvite(accept(r).api, 't', 'p'), JSON.stringify(r)).toBe('invalid');
		}
	});

	it('policy message passed through (a password the policy refuses, or an empty one)', async () => {
		const msg = 'Validation failed for field "password". Value doesn\'t have the correct format.';
		expect(await acceptInvite(accept(fail(400, 'FAILED_VALIDATION', msg)).api, 't', 'weak')).toEqual({ policy: msg });
		const empty = 'Invalid payload. "password" is not allowed to be empty.';
		expect(await acceptInvite(accept(fail(400, 'INVALID_PAYLOAD', empty)).api, 't', '')).toEqual({ policy: empty });
	});

	it('anything else (no answer, a 5xx) is thrown, not mistaken for a bad link', async () => {
		await expect(acceptInvite(accept('network').api, 't', 'p')).rejects.toBeTruthy();
		await expect(acceptInvite(accept(fail(503, 'SERVICE_UNAVAILABLE', 'down')).api, 't', 'p')).rejects.toBeTruthy();
	});
});

describe('tokenEmail', () => {
	it('reads the payload email', () => {
		expect(tokenEmail(jwtWith({ email: 'ada@example.com', scope: 'invite' }))).toBe('ada@example.com');
	});
	it('reads a non-ASCII email and a payload whose base64url needs padding', () => {
		expect(tokenEmail(jwtWith({ email: 'zoë.x@example.com' }))).toBe('zoë.x@example.com');
	});
	it('is null for anything that is not a token with an email', () => {
		expect(tokenEmail('nonsense')).toBeNull();
		expect(tokenEmail('a.b.c')).toBeNull();
		expect(tokenEmail(jwtWith({ scope: 'invite' }))).toBeNull();
		expect(tokenEmail(jwtWith({ email: 5 }))).toBeNull();
	});
});

describe('tokenFrom', () => {
	it('reads the token query value', () => {
		expect(tokenFrom({ token: 'abc' })).toBe('abc');
	});
	it('ignores arrays, empties and a missing token', () => {
		expect(tokenFrom({ token: ['a', 'b'] })).toBeNull();
		expect(tokenFrom({ token: '' })).toBeNull();
		expect(tokenFrom({ token: null })).toBeNull();
		expect(tokenFrom({})).toBeNull();
	});
});

describe('policyChecks', () => {
	// d1-server's live auth_password_policy (directus_settings), the oracle: the checklist must tick everything exactly when Directus accepts.
	const LIVE_POLICY = /(?=^.{8,}$)(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*()_+}{';'?>.<,])(?!.*\s).*$/;
	const allMet = (p: string) => policyChecks(p).every((c) => c.met);

	it('ticks every line exactly when the live policy accepts the password', () => {
		const passwords = [
			'Abcdef1!', 'Abcdef1', 'Ab1!', 'abcdefg1!', 'ABCDEFG1!', 'Abcdefgh!', 'Abcdefg1', // length, case, digit, symbol each missing
			'Abcdef1-', 'Abcdef1=', 'Abcdef1[', 'Abcdef1~', 'Abcdef1:', 'Abcdef1/', 'Abcdef1|', // symbols the policy does not count
			'Abcdef1;', "Abcdef1'", 'Abcdef1?', 'Abcdef1.', 'Abcdef1,', 'Abcdef1<', 'Abcdef1>', 'Abcdef1{', 'Abcdef1}', 'Abcdef1_', 'Abcdef1+', // ones it does
			'Abc def1!', 'Abcdef1! ', ' Abcdef1!', // whitespace is refused
			'Ünïcödé1!a', 'Abcdéf1é', 'A1!aaaaa', 'A1!aaaa',
		];
		for (const p of passwords) expect(allMet(p), JSON.stringify(p)).toBe(LIVE_POLICY.test(p));
	});

	it('names the length and spaces rules as well as the character kinds', () => {
		const labels = policyChecks('x').map((c) => c.label);
		expect(labels).toEqual(expect.arrayContaining(['at least 8 characters', 'no spaces']));
		expect(policyChecks('Abcdef1!').every((c) => c.met)).toBe(true);
		expect(policyChecks('Abc def1!').find((c) => c.label === 'no spaces')?.met).toBe(false);
	});
});
