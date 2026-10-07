import fs from 'node:fs';
import path from 'node:path';

export type RevealCheck = { ok: true; path: string; isDir: boolean } | { ok: false; reason: string };

/** Does `rel` (a `path.relative(root, target)` result) point outside the root? */
function outsideRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** May the renderer open this path in the file browser? (#96)
 *
 * The request comes from page code, so it is held to what the feature needs: an absolute path
 * that exists and lies inside the backend's current captures folder (the folder itself counts).
 * Symlinks and junctions are resolved on both sides before comparing, so a link inside the folder
 * cannot point the file browser somewhere else. `path.relative` already compares
 * case-insensitively on Windows. */
export function checkRevealTarget(requested: unknown, capturesRoot: string): RevealCheck {
  if (typeof requested !== 'string' || !requested) return { ok: false, reason: 'no path given' };
  if (!path.isAbsolute(requested)) return { ok: false, reason: 'not an absolute path' };
  // Lexical prefilter before any filesystem call: realpath on a UNC path reaches out to that SMB
  // host, so a path outside the root must be refused without the main process ever touching it.
  if (outsideRoot(path.relative(path.resolve(capturesRoot), path.resolve(requested)))) {
    return { ok: false, reason: 'only folders inside the recording folder can be opened' };
  }
  let target: string;
  let root: string;
  try {
    target = fs.realpathSync(requested);
  } catch {
    return { ok: false, reason: 'that folder no longer exists' };
  }
  try {
    root = fs.realpathSync(capturesRoot);
  } catch {
    return { ok: false, reason: 'the recording folder is not available' };
  }
  if (outsideRoot(path.relative(root, target))) {
    return { ok: false, reason: 'only folders inside the recording folder can be opened' };
  }
  let isDir: boolean;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    return { ok: false, reason: 'that folder no longer exists' };
  }
  return { ok: true, path: target, isDir };
}
