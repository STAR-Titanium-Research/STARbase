import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { SidecarSupervisor, type SidecarState } from './sidecar';

const FIXTURE = path.join(__dirname, '__fixtures__', 'fake-backend.js');

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

function freePort(): number {
  // Test-only: a high random port. Real probing is covered by port.test.ts.
  return 39000 + Math.floor(Math.random() * 5000);
}

describe('SidecarSupervisor', () => {
  let sup: SidecarSupervisor | undefined;

  afterEach(async () => {
    await sup?.stop();
  });

  it('reaches ready once the fixture backend answers /health', async () => {
    const port = freePort();
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port)],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
      onStateChange: (s) => states.push(s),
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    expect(states).toContain('starting');
    expect(states).toContain('ready');
  });

  it('reports crashed if the process never becomes healthy in time', async () => {
    const port = freePort();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port), '--delay=999999'],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 1000,
      maxRestarts: 0,
    });
    await sup.start();
    expect(sup.getState()).toBe('crashed');
  });

  it('restarts with backoff after the process dies, then gives up after maxRestarts', async () => {
    const port = freePort();
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port)],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
      maxRestarts: 1,
      onStateChange: (s) => states.push(s),
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');

    // Simulate a crash: kill the process out from under the supervisor.
    process.kill(sup.getPid()!);
    await new Promise((r) => setTimeout(r, 3000));
    expect(sup.getState()).toBe('ready');
    expect(states).toContain('restarting');
    expect(sup.getRestartCount()).toBe(1);

    // A second crash exceeds maxRestarts=1 — the supervisor must give up rather than loop forever.
    process.kill(sup.getPid()!);
    await new Promise((r) => setTimeout(r, 4000));
    expect(sup.getState()).toBe('crashed');
  }, 15000);

  it('restart() replaces a running backend with a new process and ends ready (R11)', async () => {
    const port = freePort();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port)],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
    });
    await sup.start();
    const first = sup.getPid();
    await sup.restart();
    expect(sup.getState()).toBe('ready');
    expect(sup.getPid()).not.toBe(first);
    expect(sup.getRestartCount()).toBe(0);
  }, 15000);

  it('restart() while a crash restart is waiting out its backoff leaves exactly one backend (R11)', async () => {
    const port = freePort();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port)],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
    });
    await sup.start();
    process.kill(sup.getPid()!);
    await waitFor(() => sup!.getState() === 'restarting', 3000);
    expect(sup.getState()).toBe('restarting');
    await sup.restart();
    expect(sup.getState()).toBe('ready');
    const pid = sup.getPid();
    // Outlast the 1 s backoff the manual restart overtook: it must not spawn a second backend.
    await new Promise((r) => setTimeout(r, 1500));
    expect(sup.getState()).toBe('ready');
    expect(sup.getPid()).toBe(pid);
  }, 15000);

  // stop() kills the tree with Windows `taskkill` (killTree), so this only means anything on
  // Windows. It runs in force-app-release.yml (windows-latest); the Linux CI job skips it.
  it.skipIf(process.platform !== 'win32')('stop() terminates the process so a later health request fails', async () => {
    const port = freePort();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port)],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    await sup.stop();
    await expect(
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  });

  it('keeps answering while the backend writes heavily to stdout (#106)', async () => {
    // Each request writes 2 KB to stdout synchronously, as uvicorn's access log does. 300 of
    // them is ~600 KB, far past a pipe's OS buffer — so this hangs at the first write that finds
    // the pipe full unless the supervisor drains stdout.
    const port = freePort();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port), '--chatty=2048'],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    for (let i = 0; i < 300; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      expect(res.ok).toBe(true);
      await res.text();
    }
  }, 30000);

  it('restarts a backend that stays up but stops answering /health (#106)', async () => {
    const port = freePort();
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      // Wedges its event loop 1 s after starting: the process is alive, so no exit ever fires.
      args: [FIXTURE, String(port), '--hang-after=1000'],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
      livenessIntervalMs: 200,
      livenessTimeoutMs: 200,
      livenessFailures: 2,
      onStateChange: (s) => states.push(s),
    });
    await sup.start();
    const firstPid = sup.getPid();
    await waitFor(() => sup!.getRestartCount() === 1 && sup!.getState() === 'ready', 10000);
    expect(sup.getRestartCount()).toBe(1);
    expect(sup.getState()).toBe('ready');
    expect(sup.getPid()).not.toBe(firstPid);
    expect(states).toContain('restarting');
  }, 15000);

  it('does not restart a healthy backend', async () => {
    const port = freePort();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port)],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
      livenessIntervalMs: 100,
      livenessTimeoutMs: 500,
      livenessFailures: 2,
    });
    await sup.start();
    await new Promise((r) => setTimeout(r, 1500));
    expect(sup.getState()).toBe('ready');
    expect(sup.getRestartCount()).toBe(0);
  });

  it('forgives restarts once the backend has stayed up for the stable window', async () => {
    const port = freePort();
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      // Hangs 1.5 s into every life. With maxRestarts 1 a second hang would be the give-up state
      // unless the first restart had been forgiven in between.
      args: [FIXTURE, String(port), '--hang-after=1500'],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
      maxRestarts: 1,
      livenessIntervalMs: 100,
      livenessTimeoutMs: 100,
      livenessFailures: 2,
      stableAfterMs: 300,
      onStateChange: (s) => states.push(s),
    });
    await sup.start();
    await waitFor(() => states.filter((s) => s === 'restarting').length >= 2, 15000);
    expect(states).not.toContain('crashed');
  }, 20000);

  // Review 2.9: a backend that dies while starting.
  it('fails fast when the process exits during startup instead of waiting out the timeout', async () => {
    const port = freePort();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port), '--delay=999999', '--exit-after=100'],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 15_000,
      maxRestarts: 0,
    });
    const t0 = Date.now();
    await sup.start();
    expect(sup.getState()).toBe('crashed');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(sup.lastDetail()).toMatch(/exit code=3/);
  });

  it('start() settles only after the restarts, and reports the failure once', async () => {
    const port = freePort();
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port), '--delay=999999', '--exit-after=100'],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 1500,
      maxRestarts: 1,
      onStateChange: (s) => states.push(s),
    });
    await sup.start();
    // Final state when start() returns, not 'restarting' with a second process still coming up.
    expect(sup.getState()).toBe('crashed');
    expect(sup.getRestartCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 2500));
    expect(states.filter((s) => s === 'crashed')).toHaveLength(1);
    expect(states.filter((s) => s === 'starting')).toHaveLength(2);
    expect(sup.getState()).toBe('crashed');
  });

  it('a startup that dies once and then comes up ends ready, awaited by start()', async () => {
    const port = freePort();
    // First launch dies at once; the supervisor's restart uses the same args, so make the first
    // process the only one that exits: it exits only if the port is still unbound by anything else.
    const marker = path.join(require('node:os').tmpdir(), `fb-${port}.once`);
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      args: [FIXTURE, String(port), `--exit-once=${marker}`],
      port,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
      maxRestarts: 2,
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    expect(sup.getRestartCount()).toBe(1);
    require('node:fs').rmSync(marker, { force: true });
  });
});
