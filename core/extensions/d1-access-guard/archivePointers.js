// The archive pointer rows of directus_files (ADR-0022): who may write what a pointer row says about WHERE its file is.
//
// A pointer row stands for one file on the archive share: `storage = 'star'`, `metadata.archive_path`, and an id derived from the
// path (`uuid5('file:' + path)`), which the indexer and the inbox crawler write by SQL. Directus uploads go to the `local` storage
// and never carry an archive_path, so a Lab Member has no reason to write either. The Lab Member permission on directus_files lists
// those fields (a field list cannot say "not this value"), so a member could make the row of a path they know, ahead of the
// crawler, and add a surface scan of it; the surface-scan worker would then render the folder owner's file for the whole lab.
//
// These pure functions say which writes are refused. index.js runs them on files.create, files.update and files.upload for a caller
// who is not an administrator. Indexer, crawler and imports write by SQL and never pass here; administrators and internal calls
// (no accountability) are exempt.

export const ARCHIVE_STORAGE = (process.env.STORAGE_NAME || 'star').trim().toLowerCase();

export const POINTER_REFUSED =
  'Files on the archive share are registered by the system; they cannot be created or repointed by hand';

const isBlank = (value) => value === undefined || value === null || value === '';

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
};

/** metadata.archive_path as text, or '' when there is none. */
export function archivePath(metadata) {
  const path = asObject(metadata)?.archive_path;
  return isBlank(path) ? '' : String(path);
}

const isArchiveStorage = (storage) => typeof storage === 'string' && storage.trim().toLowerCase() === ARCHIVE_STORAGE;

/** A payload that creates (or uploads) a pointer row, or one that merely looks like it. */
export function createsPointer(item) {
  if (!item || typeof item !== 'object') return false;
  return isArchiveStorage(item.storage) || archivePath(item.metadata) !== '';
}

/**
 * Whether an update turns `row` (as stored) into something that points elsewhere: its storage moves to or from the archive,
 * its archive_path changes or goes, its disk name changes on a pointer row, or an id other than its own is sent.
 * A value sent back unchanged (a form saving every field) is not a change.
 */
export function repointsPointer(row, payload) {
  if (!payload || typeof payload !== 'object' || !row) return false;
  const wasPointer = isArchiveStorage(row.storage) || archivePath(row.metadata) !== '';
  if ('storage' in payload && String(payload.storage ?? '') !== String(row.storage ?? '')) {
    if (wasPointer || isArchiveStorage(payload.storage)) return true;
  }
  if ('metadata' in payload && archivePath(payload.metadata) !== archivePath(row.metadata)) return true;
  if (wasPointer) {
    if ('filename_disk' in payload && String(payload.filename_disk ?? '') !== String(row.filename_disk ?? '')) return true;
    if ('id' in payload && String(payload.id ?? '').toLowerCase() !== String(row.id ?? '').toLowerCase()) return true;
  }
  return false;
}
