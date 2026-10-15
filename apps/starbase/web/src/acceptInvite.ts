import type { AxiosError, AxiosInstance } from 'axios';

// Accepting an invite (spec §1.6): Directus mails a link to /accept-invite?token=<JWT>; the person sets a password here, STARbase
// signs them in and sends them Home. Directus 11.17 answers POST /users/invite/accept (read in the image, @directus/api
// services/users.js acceptInvite + @directus/errors):
//   204                                   accepted
//   401 TOKEN_EXPIRED                     the 7-day token has lapsed
//   403 INVALID_TOKEN                     not a token Directus signed (cut off, edited)
//   403 FORBIDDEN                         a token Directus signed for something else (scope is not "invite")
//   400 INVALID_INVITE                    the login is no longer 'invited': the link was already used (or the login suspended)
//   400 INVALID_PAYLOAD                   Joi: a missing/empty token or password ("token" / "password" named in the message)
//   400 FAILED_VALIDATION                 the password fails auth_password_policy (field "password", type "regex")

export type AcceptResult = 'ok' | 'expired' | 'invalid' | { policy: string };

/** The page's text for a link that cannot be used. */
export const LINK_UNUSABLE = 'This invite link has expired or was already used. Ask an admin to resend it.';

const NO_CODE = 'Could not set the password.';

export async function acceptInvite(api: AxiosInstance, token: string, password: string): Promise<AcceptResult> {
	try {
		await api.post('/users/invite/accept', { token, password }, { sbNoGuard: true });
		return 'ok';
	} catch (e) {
		const first = (e as AxiosError<{ errors?: { message?: string; extensions?: { code?: string } }[] }>).response?.data?.errors?.[0];
		const code = first?.extensions?.code;
		const message = first?.message || NO_CODE;
		if (code === 'TOKEN_EXPIRED') return 'expired';
		if (code === 'INVALID_TOKEN' || code === 'INVALID_INVITE' || code === 'FORBIDDEN') return 'invalid';
		if (code === 'INVALID_PAYLOAD') return /"token"/.test(message) ? 'invalid' : { policy: message };
		if (code === 'FAILED_VALIDATION') return { policy: message };
		throw e;
	}
}

/** The token in /accept-invite?token=…: a single non-empty value (a repeated ?token=a&token=b is no token). */
export function tokenFrom(query: Record<string, unknown>): string | null {
	const t = query.token;
	return typeof t === 'string' && t !== '' ? t : null;
}

/**
 * The email Directus put in the invite token (a JWT: header.payload.signature, the payload base64url JSON). Read only to sign the person
 * in once their password is set: the signature is not checked here, Directus checks it when the password is accepted.
 */
export function tokenEmail(token: string): string | null {
	const part = token.split('.')[1];
	if (!part) return null;
	try {
		const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
		const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
		const payload: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
		const email = (payload as { email?: unknown } | null)?.email;
		return typeof email === 'string' && email !== '' ? email : null;
	} catch {
		return null;
	}
}

/**
 * The live password policy ("upper, lower, digit, symbol"; Directus's auth_password_policy, which is not readable before sign-in) as a
 * checklist for the field. A hint only: Directus decides, and its own refusal is shown if the policy has since changed.
 */
export function policyChecks(password: string): { label: string; met: boolean }[] {
	return [
		{ label: 'an upper-case letter', met: /[A-Z]/.test(password) },
		{ label: 'a lower-case letter', met: /[a-z]/.test(password) },
		{ label: 'a digit', met: /[0-9]/.test(password) },
		{ label: 'a symbol', met: /[^A-Za-z0-9]/.test(password) },
	];
}
