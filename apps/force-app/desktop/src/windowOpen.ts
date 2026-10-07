import { shell } from 'electron';
import type { WindowStateStore } from './windowState';

/** Stable key for remembering a pop-out's size/position: the pathname only, so every "Live Force"
 * pop-out (any mode/axes) shares one remembered geometry rather than one per query-string variant. */
export function popoutKey(url: string): string {
  return new URL(url).pathname;
}

/** Is this one of the app's own pages (app://force/...)? Used to vet window.open() targets, which
 * renderer an IPC request came from, and which saved pop-out URLs may be reopened at startup. */
export function isAppUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'app:' && url.hostname === 'force';
  } catch {
    return false;
  }
}

/** Did this IPC call come from one of the app's own pages? The privileged handlers (file dialogs,
 * reveal, update install) must never serve a page some navigation or window.open() slip let in. */
export function isAppSender(event: { senderFrame?: { url?: string } | null }): boolean {
  return isAppUrl(event.senderFrame?.url ?? '');
}

/** Called for every window's WebContents (app 'web-contents-created'): the app's pages only ever
 * navigate within app://force, so anything else - a stray link, a redirect, a script setting
 * location - is refused instead of loading remote content into a window that has the preload
 * bridge. External links are handled by the window-open handler above, not here. Defence in depth:
 * no current code path navigates away. Webviews are never used, so none may attach. */
export function guardNavigation(contents: {
  on(event: string, listener: (event: { preventDefault(): void }, url?: string) => void): unknown;
}): void {
  const deny = (event: { preventDefault(): void }, url?: string) => {
    if (!isAppUrl(url ?? '')) event.preventDefault();
  };
  contents.on('will-navigate', deny);
  contents.on('will-redirect', deny);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function classifyWindowOpen(
  details: Electron.HandlerDetails,
  windowState?: WindowStateStore,
): Electron.WindowOpenHandlerResponse {
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return { action: 'deny' };
  }
  if (isAppUrl(details.url)) {
    const saved = windowState?.get(popoutKey(details.url));
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        // Omitted (not just undefined) when nothing is saved yet — Electron then falls back to
        // whatever width/height the window.open() features string requested, its own existing
        // default. Setting these keys to undefined would still override that fallback with NaN.
        ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}),
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      },
    };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    void shell.openExternal(details.url);
  }
  return { action: 'deny' };
}
