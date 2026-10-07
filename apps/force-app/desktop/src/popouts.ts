import { isAppUrl } from './windowOpen';

/** More than this many pop-outs at once is not a layout anyone meant to keep — and reopening a
 * long list at every start would be its own problem. */
export const MAX_RESTORED_POPOUTS = 8;

/** The part of a BrowserWindow the tracker uses, so it can be tested without Electron. */
export interface TrackedWindow {
  isDestroyed(): boolean;
  webContents: { getURL(): string };
  once(event: 'closed', listener: () => void): unknown;
}

export interface OpenPopoutStore {
  getOpenPopouts(): unknown;
  setOpenPopouts(urls: string[]): void;
}

/** Saved pop-out URLs that may be reopened: the app's own pages only, each once, at most `max`.
 * The file is on disk and could hold anything, so nothing else from it ever reaches window.open. */
export function restorablePopoutUrls(saved: unknown, max = MAX_RESTORED_POPOUTS): string[] {
  if (!Array.isArray(saved)) return [];
  const out: string[] = [];
  for (const u of saved) {
    if (typeof u !== 'string' || !isAppUrl(u) || out.includes(u)) continue;
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** #108: remembers which pop-outs are open, so the ones open when the app quits come back on the
 * next start.
 *
 * Every open and every close the operator makes is saved as it happens. Quitting closes the
 * pop-outs too, but those closes must not count: beginQuit() takes a last snapshot (with each
 * window's current URL, which may have moved on from the one it opened with) and stops saving. */
export class PopoutTracker {
  private readonly open = new Map<TrackedWindow, string>();
  private quitting = false;
  private readonly saved: string[];

  constructor(private readonly store: OpenPopoutStore) {
    // Read once, up front: reopening them goes through track(), which rewrites the list.
    this.saved = restorablePopoutUrls(store.getOpenPopouts());
  }

  /** The pop-outs to reopen at startup. */
  toRestore(): string[] {
    return this.saved;
  }

  track(win: TrackedWindow, url: string): void {
    this.open.set(win, url);
    win.once('closed', () => {
      this.open.delete(win);
      if (!this.quitting) this.persist();
    });
    this.persist();
  }

  beginQuit(): void {
    if (this.quitting) return;
    this.persist();
    this.quitting = true;
  }

  private persist(): void {
    const urls = [...this.open].map(([win, opened]) =>
      win.isDestroyed() ? opened : win.webContents.getURL() || opened,
    );
    this.store.setOpenPopouts(restorablePopoutUrls(urls));
  }
}
