import { beforeEach, describe, expect, it } from 'vitest';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

import {
  OFFLINE_MAX_AGE_MS, enrollOfflineLogin, getOfflineProfile, listOfflineAccounts, matchesStoredPassword,
  offlineEntryValid, revokeOfflineLogin, touchOfflineVerified, updateOfflineProfile, verifyOfflineLogin,
} from './offlineAuth';

const ITER = 1000; // the real work factor is for production; tests only need the logic
const user = { id: 'u-1', role: 'r', first_name: 'Ada', last_name: 'Lovelace', email: 'Ada@Lab.org', person_id: 'p-1' };

beforeEach(() => store.clear());

describe('offline login verifier', () => {
  it('accepts the enrolled password and returns the stored profile', async () => {
    await enrollOfflineLogin('Ada@Lab.org', 'correct horse', user, ITER);
    const v = await verifyOfflineLogin('  ada@lab.org ', 'correct horse');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.user.person_id).toBe('p-1');
  });

  it('rejects a wrong password and an account that never signed in here', async () => {
    await enrollOfflineLogin('ada@lab.org', 'correct horse', user, ITER);
    expect(await verifyOfflineLogin('ada@lab.org', 'nope')).toMatchObject({ ok: false, reason: 'wrong-password' });
    expect(await verifyOfflineLogin('bob@lab.org', 'correct horse')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('never stores the password itself', async () => {
    await enrollOfflineLogin('ada@lab.org', 'correct horse', user, ITER);
    expect([...store.values()].join('')).not.toContain('correct horse');
  });

  it('uses a fresh salt each enrolment', async () => {
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    const a = store.get('force-app.auth.vault');
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    expect(store.get('force-app.auth.vault')).not.toBe(a);
  });

  it('expires after the age limit', async () => {
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    const later = Date.now() + OFFLINE_MAX_AGE_MS + 1000;
    expect(await verifyOfflineLogin('ada@lab.org', 'pw', later)).toMatchObject({ ok: false, reason: 'expired' });
    expect(listOfflineAccounts(later)).toEqual([]);
  });

  it('re-enrolling after a password change replaces the old password', async () => {
    await enrollOfflineLogin('ada@lab.org', 'old', user, ITER);
    await enrollOfflineLogin('ada@lab.org', 'new', user, ITER);
    expect((await verifyOfflineLogin('ada@lab.org', 'old')).ok).toBe(false);
    expect((await verifyOfflineLogin('ada@lab.org', 'new')).ok).toBe(true);
  });

  it('can be revoked', async () => {
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    revokeOfflineLogin('ADA@lab.org');
    expect(await verifyOfflineLogin('ada@lab.org', 'pw')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('backs off after repeated wrong passwords, and a success clears it', async () => {
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await verifyOfflineLogin('ada@lab.org', 'bad', t0);
    // The 6th wrong attempt is what starts the wait...
    expect(await verifyOfflineLogin('ada@lab.org', 'bad', t0)).toMatchObject({ ok: false, reason: 'wrong-password' });
    // ...and further attempts (even with the right password) are refused until it passes.
    expect(await verifyOfflineLogin('ada@lab.org', 'pw', t0 + 100)).toMatchObject({ ok: false, reason: 'throttled' });
    const after = await verifyOfflineLogin('ada@lab.org', 'pw', t0 + 10_000);
    expect(after.ok).toBe(true);
    expect(await verifyOfflineLogin('ada@lab.org', 'bad')).toMatchObject({ reason: 'wrong-password' }); // counter reset
  });

  it('matchesStoredPassword ignores expiry; profile updates keep the password', async () => {
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    updateOfflineProfile('ada@lab.org', { ...user, person_id: 'p-2' });
    const v = await verifyOfflineLogin('ada@lab.org', 'pw');
    expect(v.ok && v.user.person_id).toBe('p-2');
    expect(await matchesStoredPassword('ada@lab.org', 'pw')).toBe(true);
    expect(await matchesStoredPassword('ada@lab.org', 'x')).toBe(false);
  });

  it('offlineEntryValid tracks the entry: present, in date, not revoked', async () => {
    expect(offlineEntryValid('ada@lab.org')).toBe(false);
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    expect(offlineEntryValid('ADA@lab.org')).toBe(true);
    expect(offlineEntryValid('ada@lab.org', Date.now() + OFFLINE_MAX_AGE_MS + 1000)).toBe(false);
    expect(offlineEntryValid(null)).toBe(false);
    revokeOfflineLogin('ada@lab.org');
    expect(offlineEntryValid('ada@lab.org')).toBe(false);
  });

  it('touchOfflineVerified restarts the window without changing the password', async () => {
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    const later = Date.now() + OFFLINE_MAX_AGE_MS - 1000;
    touchOfflineVerified('ada@lab.org', later);
    // Would have expired a day after `later` without the touch; now it is good for a fresh window.
    expect((await verifyOfflineLogin('ada@lab.org', 'pw', later + 2 * 86_400_000)).ok).toBe(true);
    expect((await verifyOfflineLogin('ada@lab.org', 'other', later + 2 * 86_400_000)).ok).toBe(false);
    touchOfflineVerified('nobody@lab.org'); // unknown account: no-op, no throw
  });

  it('getOfflineProfile returns the stored snapshot', async () => {
    expect(getOfflineProfile('ada@lab.org')).toBeNull();
    await enrollOfflineLogin('ada@lab.org', 'pw', user, ITER);
    expect(getOfflineProfile('ADA@lab.org')?.person_id).toBe('p-1');
  });
});
