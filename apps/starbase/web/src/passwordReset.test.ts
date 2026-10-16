import { describe, expect, it } from 'vitest';
import { createApi } from './api';
import { requestErrorText, requestPasswordReset, resetPassword, resetUrl } from './passwordReset';
import { fakeServer, type Reply } from './testing/fakeServer';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const fail = (status: number, code: string, message: string): Reply => ({ status, data: { errors: [{ message, extensions: { code } }] } });

function server(reply: Reply) {
	const api = createApi(D1);
	let sent: { url?: string; body?: unknown; noGuard?: boolean } = {};
	fakeServer(api, (key, cfg) => {
		sent = { url: key, body: JSON.parse(cfg.data), noGuard: cfg.sbNoGuard };
		return reply;
	});
	return { api, sent: () => sent };
}

describe('resetUrl', () => {
	it('is this app\'s /reset-password, with no doubled slash', () => {
		expect(resetUrl('https://starbase.tail54eeb6.ts.net')).toBe('https://starbase.tail54eeb6.ts.net/reset-password');
		expect(resetUrl('https://starbase.tail54eeb6.ts.net/')).toBe('https://starbase.tail54eeb6.ts.net/reset-password');
	});
});

describe('requestPasswordReset', () => {
	it('posts the e-mail and this app\'s reset address outside the session guard', async () => {
		const { api, sent } = server(204);
		await requestPasswordReset(api, 'ada@example.com', 'https://sb.example');
		expect(sent()).toEqual({ url: 'POST /auth/password/request', body: { email: 'ada@example.com', reset_url: 'https://sb.example/reset-password' }, noGuard: true });
	});

	it('rejects when the request fails (an address off the allow-list, no answer)', async () => {
		await expect(requestPasswordReset(server(fail(400, 'INVALID_PAYLOAD', 'URL "x" can\'t be used to reset passwords')).api, 'a@b.c', 'https://x')).rejects.toBeTruthy();
		await expect(requestPasswordReset(server('network').api, 'a@b.c', 'https://x')).rejects.toBeTruthy();
	});
});

describe('resetPassword', () => {
	it('ok on 204, posting the token and password outside the session guard', async () => {
		const { api, sent } = server(204);
		expect(await resetPassword(api, 'tok', 'Pw1!')).toBe('ok');
		expect(sent()).toEqual({ url: 'POST /auth/password/reset', body: { token: 'tok', password: 'Pw1!' }, noGuard: true });
	});

	it('expired on TOKEN_EXPIRED', async () => {
		expect(await resetPassword(server(fail(401, 'TOKEN_EXPIRED', 'Token expired.')).api, 't', 'p')).toBe('expired');
	});

	it('invalid on INVALID_TOKEN, FORBIDDEN (already used, or another scope) and a token the payload check refuses', async () => {
		for (const r of [
			fail(403, 'INVALID_TOKEN', 'Invalid token.'),
			fail(403, 'FORBIDDEN', 'You don\'t have permission to access this.'),
			fail(400, 'INVALID_PAYLOAD', 'Invalid payload. "token" is not allowed to be empty.'),
		]) {
			expect(await resetPassword(server(r).api, 't', 'p'), JSON.stringify(r)).toBe('invalid');
		}
	});

	it('policy message passed through (a password the policy refuses, or an empty one)', async () => {
		const msg = 'Validation failed for field "password". Value doesn\'t have the correct format.';
		expect(await resetPassword(server(fail(400, 'FAILED_VALIDATION', msg)).api, 't', 'weak')).toEqual({ policy: msg });
		const empty = 'Invalid payload. "password" is not allowed to be empty.';
		expect(await resetPassword(server(fail(400, 'INVALID_PAYLOAD', empty)).api, 't', '')).toEqual({ policy: empty });
	});

	it('anything else (no answer, a 5xx) is thrown, not mistaken for a bad link', async () => {
		await expect(resetPassword(server('network').api, 't', 'p')).rejects.toBeTruthy();
		await expect(resetPassword(server(fail(503, 'SERVICE_UNAVAILABLE', 'down')).api, 't', 'p')).rejects.toBeTruthy();
	});
});

describe('requestErrorText', () => {
	it('names the tailnet when nothing answered, and the server\'s own message otherwise', async () => {
		const noAnswer = await requestPasswordReset(server('network').api, 'a@b.c', 'https://x').catch((e) => e);
		expect(requestErrorText(noAnswer)).toMatch(/tailnet/);
		const refused = await requestPasswordReset(server(fail(400, 'INVALID_PAYLOAD', 'URL not allowed')).api, 'a@b.c', 'https://x').catch((e) => e);
		expect(requestErrorText(refused)).toBe('URL not allowed');
	});
});
