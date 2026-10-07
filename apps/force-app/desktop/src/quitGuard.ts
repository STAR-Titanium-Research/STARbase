// What the quit guard and the auto-updater ask the backend, and how they say it to the operator.
// Kept out of main.ts (which needs a running Electron) so the decisions can be unit tested.

/** A session that quitting or restarting would interrupt. */
export interface BusySession {
  /** 'recording': acquisition is running. 'finalizing': it stopped and the backend is still writing
   * capture.mat, live_cache.bin and summary.json, which a kill leaves unwritten. */
  kind: 'recording' | 'finalizing';
  sample: string;
  elapsed: number;
  samples: number;
}

/** What GET /record/status says, with "idle" and "couldn't ask" kept apart. */
export type RecorderActivity =
  | { status: 'busy'; session: BusySession }
  | { status: 'idle' }
  /** No answer: the backend is down, still starting, slow, or replied with an error. */
  | { status: 'unknown' };

/** Reads GET /record/status. Never throws. */
export async function fetchRecorderActivity(
  request: (path: string, timeoutMs: number) => Promise<Response | null>,
): Promise<RecorderActivity> {
  try {
    const res = await request('/record/status', 2000);
    if (!res?.ok) return { status: 'unknown' };
    const s = (await res.json()) as {
      state?: string;
      elapsed_sec?: number;
      n_total?: number;
      config?: { sample_name?: string };
    };
    if (s.state !== 'recording' && s.state !== 'finalizing') return { status: 'idle' };
    return {
      status: 'busy',
      session: {
        kind: s.state,
        sample: s.config?.sample_name || 'the current run',
        elapsed: Number(s.elapsed_sec ?? 0),
        samples: Number(s.n_total ?? 0),
      },
    };
  } catch {
    return { status: 'unknown' };
  }
}

/** The running session, or null when nothing is running OR the backend cannot be asked: failing
 * OPEN keeps the operator from being trapped in an app they cannot close whenever the sidecar has
 * already died. (Restarting the recorder tells the two apart: see fetchRecorderActivity.) */
export async function fetchBusySession(
  request: (path: string, timeoutMs: number) => Promise<Response | null>,
): Promise<BusySession | null> {
  const a = await fetchRecorderActivity(request);
  return a.status === 'busy' ? a.session : null;
}

/** The dialog for quitting while `busy`. Button 0 is always the safe one, focused so a stray Enter
 * does not end a run or interrupt a save. */
export function quitDialogOptions(busy: BusySession): Electron.MessageBoxOptions {
  const mins = Math.floor(busy.elapsed / 60);
  const secs = Math.floor(busy.elapsed % 60);
  const captured = `${mins}:${String(secs).padStart(2, '0')} elapsed, ${busy.samples.toLocaleString()} samples captured.`;
  if (busy.kind === 'finalizing') {
    return {
      type: 'warning',
      buttons: ['Wait for it to finish', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'A recording is being saved',
      message: `"${busy.sample}" has stopped and is being saved.`,
      detail:
        `${captured}\n\n` +
        'Quitting now interrupts the save: the capture file, live cache and summary may not be written. ' +
        'The raw data stays on disk and can be recovered, but the recording will show as incomplete.',
    };
  }
  return {
    type: 'warning',
    buttons: ['Keep recording', 'Stop recording and quit'],
    defaultId: 0,
    cancelId: 0,
    title: 'A recording is in progress',
    message: `"${busy.sample}" is still recording.`,
    detail:
      `${captured}\n\n` +
      'Quitting stops acquisition now. Data captured so far is written to disk and can be recovered, ' +
      'but the rest of the cut will not be recorded.',
  };
}

/** True if it is safe to proceed with quitting: nothing is busy, or the operator chose to quit. */
export async function confirmQuit(deps: {
  getBusy: () => Promise<BusySession | null>;
  showMessageBox: (opts: Electron.MessageBoxOptions) => Promise<{ response: number }>;
}): Promise<boolean> {
  const busy = await deps.getBusy();
  if (!busy) return true;
  const { response } = await deps.showMessageBox(quitDialogOptions(busy));
  return response === 1;
}
