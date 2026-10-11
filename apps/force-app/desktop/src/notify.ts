// Rig-test prompts and questions reach an operator who may be looking at another window (or at the
// rig). The renderer asks for a desktop notification and a flashing taskbar button through the
// preload `notify` bridge. That is the whole privileged surface: two short strings, shown only
// while the window isn't focused, nothing returned. Page code can call it, so the arguments are
// checked here, in the main process, like every other handler.

export const NOTIFY_MAX_CHARS = 200;

export type NotifyCheck = { ok: true; title: string; body: string } | { ok: false; reason: string };

/** Both arguments must be strings of at most NOTIFY_MAX_CHARS; the title can't be empty. */
export function checkNotifyArgs(title: unknown, body: unknown): NotifyCheck {
  if (typeof title !== 'string' || typeof body !== 'string') return { ok: false, reason: 'title and body must be strings' };
  if (!title) return { ok: false, reason: 'no title given' };
  if (title.length > NOTIFY_MAX_CHARS || body.length > NOTIFY_MAX_CHARS) {
    return { ok: false, reason: `title and body must be at most ${NOTIFY_MAX_CHARS} characters` };
  }
  return { ok: true, title, body };
}

export interface NotifyDeps {
  /** The window that asked is in the foreground (focused and not minimised). */
  isFocused: () => boolean;
  /** Show the toast; throws when notifications aren't supported. */
  show: (n: { title: string; body: string }) => void;
  /** Flash the taskbar button until the window is focused. */
  flash: () => void;
}

/** `notify:show`. A focused window gets nothing: the prompt is already in front of the operator. */
export function handleNotify(deps: NotifyDeps, title: unknown, body: unknown): { ok: boolean; reason?: string } {
  const checked = checkNotifyArgs(title, body);
  if (!checked.ok) return checked;
  if (deps.isFocused()) return { ok: true };
  // Independent of each other: a PC with notifications switched off still gets the flashing button.
  try { deps.flash(); } catch { /* the window is gone */ }
  try {
    deps.show({ title: checked.title, body: checked.body });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'could not show the notification' };
  }
  return { ok: true };
}

/** More than this many rig-test toasts held at once and the oldest is closed. */
export const MAX_RIG_TOASTS = 10;

/** The toasts the main process holds a reference to (a toast that is collected loses its click
 * handler). Electron emits `close` when a toast is dismissed, but on Windows a toast that slides
 * into the Action Center may never emit it, so a plain "delete on close" set grows for the life of
 * the app. This one is bounded, and is emptied when the operator comes back to the window. */
export class ToastKeeper<T extends { close(): void }> {
  private readonly held = new Set<T>();

  constructor(private readonly max = MAX_RIG_TOASTS) {}

  get size(): number {
    return this.held.size;
  }

  /** Hold `toast`; past the cap the oldest ones are closed and released. */
  add(toast: T): void {
    this.held.add(toast);
    for (const oldest of [...this.held]) {
      if (this.held.size <= this.max) break;
      this.closeAndRelease(oldest);
    }
  }

  /** The toast closed by itself: forget it. */
  forget(toast: T): void {
    this.held.delete(toast);
  }

  /** The operator is back at the window: the toasts are stale, so close and release them all. */
  closeAll(): void {
    for (const toast of [...this.held]) this.closeAndRelease(toast);
  }

  private closeAndRelease(toast: T): void {
    this.held.delete(toast);
    try { toast.close(); } catch { /* already gone */ }
  }
}
