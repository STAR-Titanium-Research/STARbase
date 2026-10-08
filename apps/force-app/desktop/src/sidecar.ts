import { spawn, execFile, type ChildProcess } from 'node:child_process';

export type SidecarState = 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped';

export interface SidecarOptions {
  exePath: string;
  args: string[];
  cwd?: string;
  /** Extra environment for the child, merged over (not replacing) the parent's env. */
  env?: NodeJS.ProcessEnv;
  port: number;
  healthUrl: string;
  readyTimeoutMs?: number;
  maxRestarts?: number;
  /** How often a ready backend is re-checked on `healthUrl`. 0 turns the liveness probe off. */
  livenessIntervalMs?: number;
  /** How long one liveness check may take before it counts as failed. */
  livenessTimeoutMs?: number;
  /** Failed checks in a row before the backend is treated as hung and restarted. */
  livenessFailures?: number;
  /** How long a backend must stay ready before earlier restarts stop counting against `maxRestarts`. */
  stableAfterMs?: number;
  onStateChange?: (state: SidecarState, detail?: string) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESTARTS = 5;
const BACKOFF_BASE_MS = 1000;
// #106: generous on purpose. /health is a trivial async handler, so a backend that cannot answer
// it four times running (~70 s) has a blocked event loop: the live websocket is stalled and every
// other endpoint hangs with it, a recording included. A slow finalize runs in a worker thread and
// does not hold the loop for anything like that long, so it should not trip this.
const DEFAULT_LIVENESS_INTERVAL_MS = 10_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 8_000;
const DEFAULT_LIVENESS_FAILURES = 4;
// A backend that has stayed up this long has recovered: hangs spread over a day must not add up
// to the give-up state.
const DEFAULT_STABLE_AFTER_MS = 60_000;
// How long a POSIX child gets to exit on SIGTERM before it is SIGKILLed.
const TERM_GRACE_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHealthy(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Polls `url` until it answers, the deadline passes, or `exited` settles (the process died: nothing
 * will ever answer, so waiting out the rest of the timeout only delays the operator). */
async function waitForHealthy(url: string, timeoutMs: number, exited?: Promise<unknown>): Promise<boolean> {
  let gone = false;
  void exited?.then(() => { gone = true; });
  const orExit = <T>(p: Promise<T>, whenGone: T): Promise<T> =>
    exited ? Promise.race([p, exited.then(() => whenGone)]) : p;
  const deadline = Date.now() + timeoutMs;
  while (!gone && Date.now() < deadline) {
    if (await orExit(isHealthy(url, 1500), false)) return true;
    if (gone) return false;
    await orExit(sleep(300), undefined);
  }
  return false;
}

/** Windows: kill the whole process tree. A plain `proc.kill()` leaves an orphaned uvicorn
 * holding the port, which blocks the next launch — see the sidecar spec's "Quit" note. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
  });
}

/** Ends the child and resolves true once it has exited, or false if no exit was reported in time.
 * taskkill on Windows (the release build runs the unit tests there too); elsewhere (dev on
 * Linux/macOS, and CI's unit tests) there is no taskkill, so SIGTERM, then SIGKILL if the process
 * is too wedged to act on it — a backend stuck in a blocking write may never get to its handler. */
function terminate(proc: ChildProcess): Promise<boolean> {
  if (proc.pid == null || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  const exited = new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true)));
  if (process.platform === 'win32') {
    void killTree(proc.pid);
  } else {
    proc.kill('SIGTERM');
    const escalate = setTimeout(() => proc.kill('SIGKILL'), TERM_GRACE_MS);
    void exited.then(() => clearTimeout(escalate));
  }
  // Never wait forever: a quit must not hang on a child that refuses to report its exit.
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    giveUp = setTimeout(() => resolve(false), TERM_GRACE_MS + 2_000);
  });
  return Promise.race([exited, timedOut]).finally(() => clearTimeout(giveUp));
}

/** Spawns the recorder backend, polls it healthy, and restarts it with capped exponential
 * backoff if it exits unexpectedly. One instance per app run. */
export class SidecarSupervisor {
  private readonly opts: Required<Omit<SidecarOptions, 'onStateChange' | 'cwd' | 'env'>> &
    Pick<SidecarOptions, 'onStateChange' | 'cwd' | 'env'>;
  private proc: ChildProcess | null = null;
  private state: SidecarState = 'stopped';
  private detail: string | undefined;
  private restarts = 0;
  private stopping = false;
  // Bumped by every start() and stop(). A restart or spawn that was waiting (backoff sleep, health
  // poll) when the operator restarted the backend by hand sees the change and stands down, so a
  // manual restart can never leave two spawns racing for the port.
  private epoch = 0;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  // Why the current process was killed by the liveness probe, if it was — reported in place of
  // the bare exit code, which for a killed process says nothing useful.
  private hungReason: string | null = null;
  // A process the liveness probe gave up waiting on. Its restart is already under way, so a late
  // 'exit' event from it must not start a second one.
  private abandoned = new WeakSet<ChildProcess>();
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  // While a spawn is waiting to become healthy, an exit of that process is reported to the wait
  // (which handles it inline) instead of starting a second, concurrent restart: the two used to
  // race, and the operator saw the wait's timeout AND the restart's outcome as separate errors.
  private startingProc: ChildProcess | null = null;
  private startupExited: ((detail: string) => void) | null = null;

  constructor(opts: SidecarOptions) {
    this.opts = {
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
      maxRestarts: DEFAULT_MAX_RESTARTS,
      livenessIntervalMs: DEFAULT_LIVENESS_INTERVAL_MS,
      livenessTimeoutMs: DEFAULT_LIVENESS_TIMEOUT_MS,
      livenessFailures: DEFAULT_LIVENESS_FAILURES,
      stableAfterMs: DEFAULT_STABLE_AFTER_MS,
      ...opts,
    };
  }

  getState(): SidecarState {
    return this.state;
  }

  getPid(): number | null {
    return this.proc?.pid ?? null;
  }

  getRestartCount(): number {
    return this.restarts;
  }

  lastDetail(): string | undefined {
    return this.detail;
  }

  private setState(s: SidecarState, detail?: string): void {
    this.state = s;
    this.detail = detail;
    this.opts.onStateChange?.(s, detail);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.epoch += 1;
    this.restarts = 0;
    await this.spawnAndWait();
  }

  private spawnProcess(): ChildProcess {
    const proc = spawn(this.opts.exePath, this.opts.args, {
      cwd: this.opts.cwd,
      // Merge over the parent env rather than replacing it — the child still needs PATH,
      // SystemRoot, etc. Undefined opts.env spreads to nothing, so this is a no-op by default.
      env: { ...process.env, ...this.opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // #106: BOTH pipes must be read. stdout used to be piped and never read; once its OS buffer
    // filled (64 KB, i.e. a few hundred uvicorn access-log lines — replay's ~3 spectrum
    // requests/s got there in minutes), the backend's next write to it blocked, and with it the
    // event loop: every endpoint and the live websocket hung, with no exit for this supervisor to
    // notice. Both streams feed the same short tail, kept for the crash dialog.
    let outputTail = '';
    const keepTail = (chunk: Buffer) => {
      outputTail = (outputTail + chunk.toString()).slice(-4000);
    };
    proc.stdout?.on('data', keepTail);
    proc.stderr?.on('data', keepTail);
    // Everything below is per-process state: only the current process may act on it. A late event
    // from an abandoned (or otherwise replaced) process must not cancel the replacement's liveness
    // and stable timers, flip the state, or start another restart.
    const isStale = () => this.abandoned.has(proc) || this.proc !== proc;
    proc.on('exit', (code, signal) => {
      if (isStale()) return;
      this.stopLiveness();
      if (this.stopping) {
        if (this.startingProc === proc) this.startupExited?.('stopped');
        this.setState('stopped');
        return;
      }
      const why = this.hungReason ?? `exit code=${code} signal=${signal}`;
      if (this.startingProc === proc) { this.startupExited?.(`${why}\n${outputTail}`); return; }
      void this.handleUnexpectedExit(`${why}\n${outputTail}`).catch(
        (err) => {
          console.error('sidecar: handleUnexpectedExit failed', err);
        },
      );
    });
    proc.on('error', (err) => {
      if (isStale()) return;
      if (this.stopping) {
        this.setState('stopped');
        return;
      }
      if (this.startingProc === proc) { this.startupExited?.(`spawn error: ${err.message}`); return; }
      void this.handleUnexpectedExit(`spawn error: ${err.message}`).catch((handlerErr) => {
        console.error('sidecar: handleUnexpectedExit failed', handlerErr);
      });
    });
    return proc;
  }

  private async handleUnexpectedExit(detail: string): Promise<void> {
    const epoch = this.epoch;
    if (this.restarts >= this.opts.maxRestarts) {
      this.setState('crashed', `giving up after ${this.restarts} restart(s)\n${detail}`);
      return;
    }
    this.restarts += 1;
    const delay = BACKOFF_BASE_MS * 2 ** (this.restarts - 1);
    // The cause's first line rides along, so main.ts can log WHY once the backend is back up.
    const cause = detail.split('\n')[0];
    this.setState('restarting', `attempt ${this.restarts}/${this.opts.maxRestarts} in ${delay}ms: ${cause}`);
    await sleep(delay);
    if (this.stopping || epoch !== this.epoch) return;
    await this.spawnAndWait();
  }

  private async spawnAndWait(): Promise<void> {
    const epoch = this.epoch;
    this.setState('starting');
    this.hungReason = null;
    const proc = (this.proc = this.spawnProcess());
    const exited = new Promise<string>((resolve) => { this.startupExited = resolve; });
    this.startingProc = proc;
    let exitDetail: string | null = null;
    void exited.then((d) => { exitDetail = d; });
    const ready = await waitForHealthy(this.opts.healthUrl, this.opts.readyTimeoutMs, exited);
    if (this.startingProc === proc) {
      this.startingProc = null;
      this.startupExited = null;
    }
    if (this.stopping || epoch !== this.epoch) return;
    if (ready) {
      this.setState('ready');
      this.startLiveness(proc);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.restarts = 0;
      }, this.opts.stableAfterMs);
      this.stableTimer.unref?.();
    } else if (exitDetail !== null) {
      // It died before answering: take the normal restart path from here, awaited, so start()
      // returns only once the outcome is final (ready, or crashed after the last restart).
      await this.handleUnexpectedExit(exitDetail);
    } else {
      // Alive but never healthy. Stop it (it would keep holding the port) and do not let its exit
      // start a restart: the state is final.
      this.abandoned.add(proc);
      this.setState('crashed', `did not become healthy within ${this.opts.readyTimeoutMs}ms`);
      await terminate(proc);
    }
  }

  /** #106: health used to be checked only at startup, so a backend that hung (rather than
   * exited) left the app silently dead until the operator restarted it. This keeps checking a
   * ready backend and, after `livenessFailures` misses in a row, kills it; the exit then takes
   * the normal restart path, and the restart sends the renderer to Record, where the recovery
   * banner offers whatever the hung session had captured. */
  private startLiveness(proc: ChildProcess): void {
    if (this.opts.livenessIntervalMs <= 0) return;
    let failures = 0;
    const tick = async () => {
      this.livenessTimer = null;
      if (this.stopping || this.proc !== proc) return;
      const ok = await isHealthy(this.opts.healthUrl, this.opts.livenessTimeoutMs);
      if (this.stopping || this.proc !== proc || proc.exitCode !== null) return;
      failures = ok ? 0 : failures + 1;
      if (failures >= this.opts.livenessFailures) {
        this.hungReason = `stopped answering ${this.opts.healthUrl} (${failures} checks in a row); restarted it`;
        console.error(`sidecar: ${this.hungReason}`);
        const exited = await terminate(proc);
        if (!exited && !this.stopping && this.proc === proc) {
          // No exit event even after the kill: the process is gone for our purposes. Without this
          // the state would stay 'ready' for good, with nothing left watching it.
          this.abandoned.add(proc);
          this.stopLiveness();
          await this.handleUnexpectedExit(`${this.hungReason}; it did not report exiting`);
        }
        return;
      }
      this.scheduleLiveness(tick);
    };
    this.scheduleLiveness(tick);
  }

  private scheduleLiveness(tick: () => Promise<void>): void {
    // One check at a time — a setTimeout chain, not setInterval, so a slow check never overlaps
    // the next. unref'd so a pending check never keeps the process alive on its own.
    this.livenessTimer = setTimeout(() => void tick(), this.opts.livenessIntervalMs);
    this.livenessTimer.unref?.();
  }

  private stopLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  /** Stops the backend and starts a fresh one on the same port, resolving once that outcome is
   * final (ready, or crashed). Reuses stop() and start(), so it is the same spawn, health-wait and
   * liveness path as launch; the restart budget starts over, as it does for any start(). */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.epoch += 1;
    this.stopLiveness();
    if (!this.proc || this.proc.pid == null || this.proc.exitCode !== null) {
      this.setState('stopped');
      return;
    }
    await terminate(this.proc);
    this.setState('stopped');
  }
}
