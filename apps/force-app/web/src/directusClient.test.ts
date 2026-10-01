import { beforeEach, describe, expect, it, vi } from 'vitest';

// The interceptor's decision table, driven through a fake adapter (no network): what happens to the
// session when a request comes back 401 and the refresh that follows can't reach the server.
const auth = vi.hoisted(() => ({
  state: { accessToken: 'at', refreshToken: 'rt' as string | null, offline: false },
  getAccessToken: () => 'at',
  refresh: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('./authStore', () => ({ authStore: auth }));
vi.mock('./config', () => ({ getConfig: () => ({ directusUrl: 'http://directus' }) }));

import { api, setUnauthorizedHandler } from './directusClient';

const onUnauthorized = vi.fn();
const reply = (status: number) => (cfg: any) =>
  Promise.reject(Object.assign(new Error(`HTTP ${status}`), { config: cfg, response: { status, data: {}, config: cfg } }));

beforeEach(() => {
  auth.state.refreshToken = 'rt';
  auth.state.offline = false;
  auth.refresh.mockReset();
  auth.clear.mockReset();
  onUnauthorized.mockReset();
  setUnauthorizedHandler(onUnauthorized);
  api.defaults.adapter = reply(401);
});

describe('401 handling', () => {
  it('a refresh that could not reach the server does NOT sign the user out', async () => {
    // refresh() returns false but leaves the refresh token: only a refusal clears it.
    auth.refresh.mockResolvedValue(false);

    await expect(api.get('/items/x')).rejects.toThrow('HTTP 401');

    expect(auth.clear).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('a refresh the server refused ends the session', async () => {
    auth.refresh.mockImplementation(async () => { auth.state.refreshToken = null; return false; });

    await expect(api.get('/items/x')).rejects.toThrow('HTTP 401');

    expect(auth.clear).toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it('an offline session is never signed out by a 401', async () => {
    auth.state.refreshToken = null;
    auth.state.offline = true;

    await expect(api.get('/items/x')).rejects.toThrow('HTTP 401');

    expect(auth.clear).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('a 403 never signs out', async () => {
    api.defaults.adapter = reply(403);
    auth.refresh.mockResolvedValue(false);
    await expect(api.get('/items/x')).rejects.toThrow('HTTP 403');
    expect(auth.clear).not.toHaveBeenCalled();
  });
});
