// On-device login verifier, so an operator can sign in with no connection to Directus.
//
// Directus is the only account system, and its password hashes never leave the server (the API
// redacts `password`, and they are argon2 -- not something to ship to every rig anyway). So this
// app keeps its OWN verifier, made from the password the operator actually types during a
// successful ONLINE sign-in: a salted PBKDF2-SHA256 hash plus a snapshot of the profile Directus
// returned. Offline, typing the same password re-derives the hash and, if it matches, opens an
// "offline session" as that Directus user. Nothing here can mint a Directus token -- an offline
// session can record and queue, and syncs only once the user signs in online again.
//
// Bounds on what this trusts:
//   - only accounts that have signed in on THIS PC can sign in offline (no list of everyone);
//   - an entry expires OFFLINE_MAX_AGE_MS after its last online verification, so an account that
//     was disabled or had its password changed server-side stops working here within that window;
//   - an online 401 for a password this vault still accepts revokes the entry straight away
//     (password changed / account disabled), see authStore.login();
//   - repeated wrong passwords back off exponentially.
import type { DirectusUser } from './authStore';

const LS_KEY = 'force-app.auth.vault';
const LS_THROTTLE = 'force-app.auth.vault.throttle';

/** How long after its last online sign-in an account can still sign in offline. */
export const OFFLINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** PBKDF2 work factor. ~0.3 s on an acquisition PC; raising it only affects new entries. */
export const PBKDF2_ITERATIONS = 310_000;

const MAX_FREE_ATTEMPTS = 5;

export interface VaultEntry {
	email: string; // normalised (trimmed, lower-case): the lookup key
	salt: string; // base64
	iterations: number;
	hash: string; // base64 PBKDF2-SHA256, 32 bytes
	user: DirectusUser; // last profile Directus returned for this account
	verifiedAt: number; // epoch ms of the last ONLINE sign-in that refreshed this entry
}

type Vault = Record<string, VaultEntry>;

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

function readVault(): Vault {
	try {
		const v = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
		return v && typeof v === 'object' ? (v as Vault) : {};
	} catch {
		return {};
	}
}
function writeVault(v: Vault): void {
	localStorage.setItem(LS_KEY, JSON.stringify(v));
}

const b64 = (b: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * WebCrypto only exists in a secure context: the Electron shell (app:// is registered secure) and
 * https/localhost browsers have it; the plain-http tailnet URL does not. Without it there is no
 * offline sign-in, and nothing is stored -- online sign-in is unaffected.
 */
export function offlineSignInSupported(): boolean {
	return typeof crypto !== 'undefined' && !!crypto.subtle;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
	return new Uint8Array(bits);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
	return d === 0;
}

/** Remember (or refresh) an account after a successful ONLINE sign-in. */
export async function enrollOfflineLogin(
	email: string,
	password: string,
	user: DirectusUser,
	iterations: number = PBKDF2_ITERATIONS,
): Promise<void> {
	if (!offlineSignInSupported()) return;
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, iterations);
	const key = normaliseEmail(email);
	const vault = readVault();
	vault[key] = { email: key, salt: b64(salt), iterations, hash: b64(hash), user, verifiedAt: Date.now() };
	writeVault(vault);
	clearThrottle();
}

export type OfflineVerdict =
	| { ok: true; user: DirectusUser; verifiedAt: number }
	| { ok: false; reason: 'unknown' | 'expired' | 'wrong-password' | 'throttled'; retryInMs?: number };

/**
 * Check a password against the stored verifier without touching the entry. `unknown` means this
 * account has never signed in online on this PC (the caller should say so, not just "wrong
 * password"). Throttling applies to offline attempts only.
 */
export async function verifyOfflineLogin(email: string, password: string, now: number = Date.now()): Promise<OfflineVerdict> {
	if (!offlineSignInSupported()) return { ok: false, reason: 'unknown' };
	const wait = throttleRemainingMs(now);
	if (wait > 0) return { ok: false, reason: 'throttled', retryInMs: wait };
	const entry = readVault()[normaliseEmail(email)];
	if (!entry) return { ok: false, reason: 'unknown' };
	if (now - entry.verifiedAt > OFFLINE_MAX_AGE_MS) return { ok: false, reason: 'expired' };
	const got = await derive(password, unb64(entry.salt), entry.iterations);
	if (!sameBytes(got, unb64(entry.hash))) {
		recordFailure(now);
		return { ok: false, reason: 'wrong-password' };
	}
	clearThrottle();
	return { ok: true, user: entry.user, verifiedAt: entry.verifiedAt };
}

/** Is this password still accepted by the stored verifier? Ignores expiry and throttling. */
export async function matchesStoredPassword(email: string, password: string): Promise<boolean> {
	if (!offlineSignInSupported()) return false;
	const entry = readVault()[normaliseEmail(email)];
	if (!entry) return false;
	const got = await derive(password, unb64(entry.salt), entry.iterations);
	return sameBytes(got, unb64(entry.hash));
}

export function revokeOfflineLogin(email: string): void {
	const vault = readVault();
	delete vault[normaliseEmail(email)];
	writeVault(vault);
}

/** Accounts that can currently sign in offline on this PC (for the Connectivity page). */
export function listOfflineAccounts(now: number = Date.now()): { email: string; name: string; verifiedAt: number; expiresAt: number }[] {
	return Object.values(readVault())
		.map((e) => ({
			email: e.email,
			name: [e.user?.first_name, e.user?.last_name].filter(Boolean).join(' ') || e.email,
			verifiedAt: e.verifiedAt,
			expiresAt: e.verifiedAt + OFFLINE_MAX_AGE_MS,
		}))
		.filter((a) => a.expiresAt > now)
		.sort((a, b) => b.verifiedAt - a.verifiedAt);
}

/** The stored profile for an account, if it has an entry (used to keep fields a failed lookup could not refresh). */
export function getOfflineProfile(email: string): DirectusUser | null {
	return readVault()[normaliseEmail(email)]?.user ?? null;
}

/**
 * Is this account still allowed to hold an offline session? False once its entry is gone
 * (forgotten, revoked on a server 401) or past the age limit. Checked on restore and on navigation,
 * so revoking an account also ends a session that is already open.
 */
export function offlineEntryValid(email: string | null | undefined, now: number = Date.now()): boolean {
	if (!email) return false;
	const e = readVault()[normaliseEmail(email)];
	return !!e && now - e.verifiedAt <= OFFLINE_MAX_AGE_MS;
}

/**
 * The server has just vouched for this account again (a token refresh succeeded, so it still
 * exists and isn't suspended). Restart its offline window without touching the hash: someone who
 * stays signed in for weeks on a refresh token must not lose offline sign-in for it.
 */
export function touchOfflineVerified(email: string, now: number = Date.now()): void {
	const vault = readVault();
	const e = vault[normaliseEmail(email)];
	if (!e) return;
	e.verifiedAt = now;
	writeVault(vault);
}

/** Refresh the stored profile snapshot (role, person link) without re-deriving the password hash. */
export function updateOfflineProfile(email: string, user: DirectusUser): void {
	const vault = readVault();
	const e = vault[normaliseEmail(email)];
	if (!e) return;
	e.user = user;
	writeVault(vault);
}

// ---- brute-force back-off ------------------------------------------------------------------
// After MAX_FREE_ATTEMPTS wrong passwords in a row, each further attempt doubles the wait
// (2 s, 4 s, ... capped at 5 min). Persisted so closing and reopening the app does not reset it.
interface Throttle { fails: number; until: number }
function readThrottle(): Throttle {
	try {
		return JSON.parse(localStorage.getItem(LS_THROTTLE) || '{"fails":0,"until":0}');
	} catch {
		return { fails: 0, until: 0 };
	}
}
function throttleRemainingMs(now: number): number {
	return Math.max(0, readThrottle().until - now);
}
function recordFailure(now: number): void {
	const t = readThrottle();
	const fails = t.fails + 1;
	const over = fails - MAX_FREE_ATTEMPTS;
	const delay = over > 0 ? Math.min(5 * 60_000, 1000 * 2 ** over) : 0;
	localStorage.setItem(LS_THROTTLE, JSON.stringify({ fails, until: delay ? now + delay : 0 }));
}
function clearThrottle(): void {
	localStorage.removeItem(LS_THROTTLE);
}
