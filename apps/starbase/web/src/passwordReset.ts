import type { AxiosError, AxiosInstance } from 'axios';
import { isRestarting, unreachableText } from './api';

// Forgotten passwords (the counterpart of acceptInvite.ts). Directus 11.17 (@directus/api controllers/auth.js, services/users.js):
//   POST /auth/password/request { email, reset_url }
//     204   always, for any e-mail: an unknown, suspended or SSO login is logged and still answered 204, so the page cannot be used to
//           find out who has an account. The mail links to reset_url?token=<JWT>, good for a day.
//     400 INVALID_PAYLOAD   reset_url is not on PASSWORD_RESET_URL_ALLOW_LIST (docker-compose.yml: STARBASE_URL + /reset-password), or a bad e-mail
//   POST /auth/password/reset { token, password }
//     204                                   the password is changed (and the token can no longer be used: it carries a hash of the old one)
//     401 TOKEN_EXPIRED                     the one-day token has lapsed
//     403 INVALID_TOKEN                     not a token Directus signed (cut off, edited)
//     403 FORBIDDEN                         a token for something else, or already used (the password hash no longer matches)
//     400 FAILED_VALIDATION / INVALID_PAYLOAD   the password fails auth_password_policy, or is empty

export type ResetResult = 'ok' | 'expired' | 'invalid' | { policy: string };

/** The page's text for a reset link that cannot be used. */
export const RESET_LINK_UNUSABLE = 'This password reset link has expired or was already used. Ask for a new one.';

/** Where the reset e-mail points: this app's own /reset-password, which the server allow-lists as STARBASE_URL + /reset-password. */
export const resetUrl = (origin: string): string => `${origin.replace(/\/+$/, '')}/reset-password`;

/**
 * Ask Directus to mail a reset link. Resolves for every address (Directus answers 204 whether or not an account exists); rejects only when
 * the request itself failed (no answer, or a reset_url the server does not allow), which the page shows as an error.
 */
export async function requestPasswordReset(api: AxiosInstance, email: string, origin: string): Promise<void> {
	await api.post('/auth/password/request', { email, reset_url: resetUrl(origin) }, { sbNoGuard: true });
}

export async function resetPassword(api: AxiosInstance, token: string, password: string): Promise<ResetResult> {
	try {
		await api.post('/auth/password/reset', { token, password }, { sbNoGuard: true });
		return 'ok';
	} catch (e) {
		const first = (e as AxiosError<{ errors?: { message?: string; extensions?: { code?: string } }[] }>).response?.data?.errors?.[0];
		const code = first?.extensions?.code;
		const message = first?.message || 'Could not set the password.';
		if (code === 'TOKEN_EXPIRED') return 'expired';
		if (code === 'INVALID_TOKEN' || code === 'FORBIDDEN') return 'invalid';
		if (code === 'INVALID_PAYLOAD') return /"token"/.test(message) ? 'invalid' : { policy: message };
		if (code === 'FAILED_VALIDATION') return { policy: message };
		throw e;
	}
}

/** The text for a reset request that failed (no answer, or a refused reset_url). */
export function requestErrorText(e: unknown): string {
	const err = e as AxiosError<{ errors?: { message?: string }[] }>;
	if (!err?.response || isRestarting(e)) return unreachableText(e);
	return err.response.data?.errors?.[0]?.message || 'Could not send the reset e-mail.';
}
