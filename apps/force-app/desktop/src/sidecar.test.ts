import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPortFree } from './port';
import { SidecarSupervisor, type SidecarState } from './sidecar';

const FIXTURE = path.join(__dirname, '__fixtures__', 'fake-backend.js');

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

// Fixture ports come from below every OS's ephemeral range (Linux 32768+, Windows and macOS
// 49152+). The old random pick from 39000-44000 sat inside Linux's, where the OS hands ports out to
// outgoing connections, these tests' own health checks included: on CI the fixture now and then
// found its port taken and died at listen() with EADDRINUSE. No port is given out twice in a run,
// and each is checked bindable on the fixture's own address, which also skips Windows' reserved ranges.
const PORT_BASE = 20000;
const PORT_SPAN = 10000;
let nextPort = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);

async function freePort(): Promise<number> {
  for (let tries = 0; tries < 100; tries++) {
    const port = nextPort;
    nextPort = PORT_BASE + ((nextPort - PORT_BASE + 1) % PORT_SPAN);
    if (await isPortFree(port, '127.0.0.1')) return port;
  }
  throw new Error('no free fixture port');
}

/** Supervisor options pointing at a fixture backend of the test's own: its port, its args, and a
 * health URL with a token only that process answers to, so 'ready' can never come from some other
 * process holding the port. */
async function backend(...extraArgs: string[]) {
  const port = await freePort();
  const token = randomUUID();
  return {
    port,
    args: [FIXTURE, String(port), `--token=${token}`, ...extraArgs],
    healthUrl: `http://127.0.0.1:${port}/health/${token}`,
  };
}

describe('SidecarSupervisor', () => {
  let sup: SidecarSupervisor | undefined;

  afterEach(async () => {
    await sup?.stop();
    sup = undefined;
  });

  it('reaches ready once the fixture backend answers /health', async () => {
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend()),
      readyTimeoutMs: 5000,
      onStateChange: (s) => states.push(s),
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    expect(states).toContain('starting');
    expect(states).toContain('ready');
  });

  it('reports crashed if the process never becomes healthy in time', async () => {
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend('--delay=999999')),
      readyTimeoutMs: 1000,
      maxRestarts: 0,
    });
    await sup.start();
    expect(sup.getState()).toBe('crashed');
  });

  it('restarts with backoff after the process dies, then gives up after maxRestarts', async () => {
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend()),
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
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend()),
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
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend()),
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
    const b = await backend();
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...b,
      readyTimeoutMs: 5000,
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    await sup.stop();
    await expect(
      fetch(b.healthUrl, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  });

  it('keeps answering while the backend writes heavily to stdout (#106)', async () => {
    // Each request writes 2 KB to stdout synchronously, as uvicorn's access log does. 300 of
    // them is ~600 KB, far past a pipe's OS buffer — so this hangs at the first write that finds
    // the pipe full unless the supervisor drains stdout.
    const b = await backend('--chatty=2048');
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...b,
      readyTimeoutMs: 5000,
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    for (let i = 0; i < 300; i++) {
      const res = await fetch(b.healthUrl, { signal: AbortSignal.timeout(2000) });
      expect(res.ok).toBe(true);
      await res.text();
    }
  }, 30000);

  it('restarts a backend that stays up but stops answering /health (#106)', async () => {
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      // Wedges its event loop 1 s after starting: the process is alive, so no exit ever fires.
      ...(await backend('--hang-after=1000')),
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
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend()),
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
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      // Hangs 1.5 s into every life. With maxRestarts 1 a second hang would be the give-up state
      // unless the first restart had been forgiven in between.
      ...(await backend('--hang-after=1500')),
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
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend('--delay=999999', '--exit-after=100')),
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
    const states: SidecarState[] = [];
    sup = new SidecarSupervisor({
      exePath: process.execPath,
      ...(await backend('--delay=999999', '--exit-after=100')),
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
    // First launch dies at once; the supervisor's restart uses the same args, so make the first
    // process the only one that exits: it leaves a marker file that later launches find. The marker
    // lives in a fresh directory, so a leftover from an earlier, aborted run can never be found.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'));
    try {
      sup = new SidecarSupervisor({
        exePath: process.execPath,
        ...(await backend(`--exit-once=${path.join(dir, 'once')}`)),
        readyTimeoutMs: 5000,
        maxRestarts: 2,
      });
      await sup.start();
      expect(sup.getState()).toBe('ready');
      expect(sup.getRestartCount()).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
