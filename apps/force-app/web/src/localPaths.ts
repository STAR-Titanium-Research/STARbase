// Local file-system paths the recorder backend reports (#96): copying them, and opening them in
// the file browser. Opening needs the desktop app's shell (window.forceApp), and only makes sense
// when the recorder is this machine — a path on some other PC's disk cannot be opened from here.
import { getConfig } from './config';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalRecorderUrl(url: string): boolean {
	try {
		return LOOPBACK.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** Can "Show in folder" work here? The desktop app, talking to its own local backend. */
export function canRevealPaths(): boolean {
	return typeof window.forceApp?.revealPath === 'function' && isLocalRecorderUrl(getConfig().recorderUrl);
}

/** Opens `target` in the file browser. Resolves to null on success, or the reason it could not. */
export async function revealPath(target: string): Promise<string | null> {
	if (!window.forceApp?.revealPath) return 'only available in the desktop app';
	try {
		const res = await window.forceApp.revealPath(target);
		return res.ok ? null : res.reason || 'could not open the folder';
	} catch (e: any) {
		return e?.message || 'could not open the folder';
	}
}

/** Copies text to the clipboard. False when the browser refuses (no permission, insecure origin). */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
