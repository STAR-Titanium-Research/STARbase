import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A child that never reports its exit, however it is killed: the case the liveness probe's
// terminate() has to give up on rather than wait for.
const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  pid = 1000 + spawned.length;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const c = new FakeChild();
    spawned.push(c);
    return c;
  }),
  execFile: vi.fn((_cmd: string, _args: string[], cb: () => void) => cb()),
}));

import { execFile } from 'node:child_process';
import { SidecarSupervisor, type SidecarState } from './sidecar';

// terminate() kills the process tree with taskkill on Windows (the release build runs these tests
// there) and sends SIGTERM elsewhere: check whichever this platform uses.
function expectTerminated(child: FakeChild): void {
  if (process.platform === 'win32') {
    expect(execFile).toHaveBeenCalledWith(
      'taskkill', ['/pid', String(child.pid), '/T', '/F'], expect.any(Function),
    );
  } else {
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  }
}

describe('SidecarSupervisor when a hung backend will not report its exit', () => {
  let healthy = true;

  beforeEach(() => {
    spawned.length = 0;
    vi.mocked(execFile).mockClear();
    healthy = true;
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: healthy })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restarts through the normal path instead of staying ready forever', async () => {
    const states: SidecarState[] = [];
    const sup = new SidecarSupervisor({
      exePath: 'backend',
      args: [],
      port: 1,
      healthUrl: 'http://127.0.0.1:1/health',
      readyTimeoutMs: 5000,
      livenessIntervalMs: 1000,
      livenessTimeoutMs: 500,
      livenessFailures: 2,
      onStateChange: (s) => states.push(s),
    });
    await sup.start();
    expect(sup.getState()).toBe('ready');
    expect(spawned).toHaveLength(1);

    healthy = false; // from here the backend is hung
    // Two failed checks, then terminate()'s grace + give-up window, then the restart backoff.
    await vi.advanceTimersByTimeAsync(2000 + 1000 + 5000 + 1000 + 500);
    expectTerminated(spawned[0]);
    expect(states).toContain('restarting');
    expect(spawned).toHaveLength(2);

    // The old process finally reports its exit: that must not start a third.
    spawned[0].emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawned).toHaveLength(2);

    healthy = true;
    const stopping = sup.stop();
    spawned[1].emit('exit', 0, null);
    await stopping;
  });

  it("keeps the replacement's liveness probe running when the abandoned process finally exits", async () => {
    const sup = new SidecarSupervisor({
      exePath: 'backend',
      args: [],
      port: 1,
      healthUrl: 'http://127.0.0.1:1/health',
      readyTimeoutMs: 5000,
      livenessIntervalMs: 1000,
      livenessTimeoutMs: 500,
      livenessFailures: 2,
      stableAfterMs: 60_000,
    });
    await sup.start();
    healthy = false;
    // Two failed checks, then terminate()'s grace + give-up window: the first process is abandoned.
    await vi.advanceTimersByTimeAsync(2000 + 5000 + 1);
    // The replacement comes up healthy after the restart backoff.
    healthy = true;
    await vi.advanceTimersByTimeAsync(1000 + 100);
    expect(spawned).toHaveLength(2);
    expect(sup.getState()).toBe('ready');
    expect(sup.getRestartCount()).toBe(1);

    // The abandoned process finally reports its exit. It must not touch the replacement's timers.
    spawned[0].emit('exit', null, 'SIGKILL');

    // The restart count still resets once the replacement has been stable...
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sup.getRestartCount()).toBe(0);

    // ...and the replacement is still health-checked: when it hangs it is terminated in turn.
    healthy = false;
    await vi.advanceTimersByTimeAsync(2000 + 100);
    expectTerminated(spawned[1]);

    const stopping = sup.stop();
    spawned[1].emit('exit', null, 'SIGTERM');
    await stopping;
  });

  it('leaves no timer behind once terminate() resolves', async () => {
    const sup = new SidecarSupervisor({
      exePath: 'backend',
      args: [],
      port: 1,
      healthUrl: 'http://127.0.0.1:1/health',
      readyTimeoutMs: 5000,
      livenessIntervalMs: 0,
    });
    await sup.start();
    const stopping = sup.stop();
    spawned[0].exitCode = 0;
    spawned[0].emit('exit', 0, null);
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });
});
