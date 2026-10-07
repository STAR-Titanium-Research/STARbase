// "Restart recorder" (R11): the decision and the sequence, kept out of main.ts (which needs a
// running Electron) so they can be unit tested.
import type { RecorderActivity } from './quitGuard';
import type { SidecarState } from './sidecar';

export interface RestartResult {
  ok: boolean;
  reason?: string;
}

export type RestartDecision =
  | { action: 'restart' }
  | { action: 'refuse'; reason: string }
  /** The recorder did not say whether it is recording: ask the operator. */
  | { action: 'confirm' };

/** May the backend be restarted? A recording, or a stopped one still being written, blocks it: a
 * restart kills the process and leaves the cut's files unwritten.
 *
 * `unknown` (the status request failed or timed out) is not the same as idle. A recording backend
 * that is slow to answer looks exactly like that, so while the supervisor believes the backend is
 * `ready` the operator is asked. In any other supervisor state the backend is already known to be
 * down or on its way up, which is what the button is for, so it restarts without asking. */
export function restartDecision(activity: RecorderActivity, supervisor: SidecarState | undefined): RestartDecision {
  if (activity.status === 'idle') return { action: 'restart' };
  if (activity.status === 'unknown') return supervisor === 'ready' ? { action: 'confirm' } : { action: 'restart' };
  const busy = activity.session;
  return {
    action: 'refuse',
    reason:
      busy.kind === 'finalizing'
        ? `A recording of ${busy.sample} is still being saved. Wait for it to finish, then restart.`
        : `A recording of ${busy.sample} is in progress. Stop it first; restarting the recorder would end it.`,
  };
}

/** The confirmation for an `unknown` status. Enter and Escape both mean "Don't restart". */
export function unknownStatusDialog(): Electron.MessageBoxOptions {
  return {
    type: 'warning',
    buttons: ["Don't restart", 'Restart anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Restart recorder',
    message: "The recorder isn't answering, a recording may be in progress. Restart anyway?",
    detail: 'Restarting ends a recording that is running and may leave its files unwritten.',
  };
}

export interface RestartDeps {
  /** GET /record/status, as the quit guard reads it, with "idle" and "no answer" kept apart. */
  getActivity: () => Promise<RecorderActivity>;
  /** Shows the unknown-status confirmation; true = restart anyway. */
  confirmUnknown: () => Promise<boolean>;
  /** supervisor.restart(), or null when there is no supervisor yet. */
  restart: (() => Promise<void>) | null;
  getState: () => SidecarState | undefined;
  lastDetail: () => string | undefined;
}

/** Is a 'ready' report the end of a crash recovery, i.e. should it be logged and the operator sent
 * back to Record (where the recovery banner picks up the interrupted session)? Not while the
 * operator's own "Restart recorder" is under way: start() resets the restart count, but a first
 * spawn that fails to bind is retried and counts again, and that must not read as a crash. */
export function isCrashRecovery(state: SidecarState, restartCount: number, manualRestart: boolean): boolean {
  return state === 'ready' && restartCount > 0 && !manualRestart;
}

/** Checks, restarts, and reports whether the backend came back. Never throws. */
export async function restartRecorder(deps: RestartDeps): Promise<RestartResult> {
  if (!deps.restart) return { ok: false, reason: 'The recorder has not been started yet.' };
  // The state is read after the status request returns: it may have changed while that waited.
  const decision = restartDecision(await deps.getActivity(), deps.getState());
  if (decision.action === 'refuse') return { ok: false, reason: decision.reason };
  if (decision.action === 'confirm' && !(await deps.confirmUnknown())) {
    return { ok: false, reason: 'The recorder was not restarted.' };
  }
  if (decision.action === 'confirm') {
    // The dialog may have been open for a while: a recording can have started in the meantime.
    // Only a definite "busy" blocks; unknown again is what the operator just agreed to.
    const again = restartDecision(await deps.getActivity(), deps.getState());
    if (again.action === 'refuse') return { ok: false, reason: again.reason };
  }
  try {
    await deps.restart();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (deps.getState() === 'ready') return { ok: true };
  return { ok: false, reason: deps.lastDetail() ?? 'The recorder did not start. See Settings > Logs.' };
}
