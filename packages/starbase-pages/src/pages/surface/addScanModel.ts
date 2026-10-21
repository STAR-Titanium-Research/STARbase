// The "Add a surface scan" form's pure parts: which library files are offered, what a form must hold before it can
// be sent, and the words of the visibility warning. No Vue.

import { formatDate, operationLabel, processLabel } from '@d1/ui';
import { SCAN_CONDITIONS, type ScanCondition } from './scanModel';

// File types the library search offers: topography formats of SurfaceTopography 1.25 (Alicona .al3d first), without the
// generic ones (.tif .tiff .xyz .asc .hfm .npy, plain text and arrays). The render worker has the last word: it builds
// its own list from SurfaceTopography's readers minus its exclusions (plugins/surface-scan-worker app/lib/archive.py),
// and a file it refuses fails its render with the reason, which "Render again" shows. THIS LIST MUST STAY INSIDE THE
// WORKER'S LIST: a file offered here that the worker refuses is a scan that can only fail.
export const TOPOGRAPHY_EXTENSIONS = [
	'.al3d', '.opd', '.opdx', '.x3p', '.ibw', '.h5', '.datx', '.sur', '.plu', '.apx', '.plux', '.vk3', '.vk4', '.vk6', '.vk7', '.lext', '.zon',
	'.os3d', '.sdf', '.frt', '.mnt', '.gwy', '.mdt', '.nms', '.oir', '.poir', '.ezd', '.nid', '.bcr', '.bcrf', '.tmd', '.zmg', '.mi', '.jpk',
	'.qep', '.spm',
] as const;

/** Only files on the archive share (a pointer row, `storage = 'star'`): the worker reads them by metadata.archive_path and refuses the rest. */
export const ARCHIVE_STORAGE = 'star';

/** The visible warning of the dialog (spec 2026-10-21, "STARbase"): who sees a scan follows its file's owner (ADR-0023). */
export const VISIBILITY_WARNING =
	"Only the file's owner (or its team) and administrators see this scan's file and 3D view; others see that the item has a scan. Files with no owner stay visible to every lab member.";

export interface LibraryFile {
	id: string;
	name: string;
	/** Where an archive file lives on the share, to tell apart files of the same name. */
	path: string | null;
	size: number | null;
}

/** The /files filter for the picker: an archive file with a topography extension, and the typed text in the name or title. */
export function fileFilter(text: string): Record<string, unknown> {
	const clauses: Record<string, unknown>[] = [
		{ storage: { _eq: ARCHIVE_STORAGE } },
		{ _or: TOPOGRAPHY_EXTENSIONS.map((ext) => ({ filename_download: { _iends_with: ext } })) },
	];
	const t = text.trim();
	if (t) clauses.push({ _or: [{ filename_download: { _icontains: t } }, { title: { _icontains: t } }] });
	return { _and: clauses };
}

export const FILE_FIELDS = ['id', 'filename_download', 'title', 'filesize', 'metadata'];

function archivePath(metadata: unknown): string | null {
	let m = metadata;
	if (typeof m === 'string') {
		try {
			m = JSON.parse(m);
		} catch {
			return null;
		}
	}
	const p = (m as { archive_path?: unknown } | null)?.archive_path;
	return typeof p === 'string' && p ? p : null;
}

export function normaliseFile(raw: any): LibraryFile | null {
	const id = typeof raw?.id === 'string' ? raw.id : '';
	if (!id) return null;
	const path = archivePath(raw?.metadata);
	const name = (typeof raw?.filename_download === 'string' && raw.filename_download) || (typeof raw?.title === 'string' && raw.title) || path?.split('/').pop() || '(file)';
	const size = typeof raw?.filesize === 'number' ? raw.filesize : typeof raw?.filesize === 'string' && /^\d+$/.test(raw.filesize) ? Number(raw.filesize) : null;
	return { id, name, path, size };
}

export function formatBytes(n: number | null): string {
	if (n === null || !Number.isFinite(n) || n < 0) return '';
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export interface ScanForm {
	file: LibraryFile | null;
	condition: ScanCondition | null;
	note: string;
	date: string;
	operationId: string | null;
}

export const emptyForm = (): ScanForm => ({ file: null, condition: null, note: '', date: '', operationId: null });

/** Why the form cannot be sent yet, in the order the person fills it in; empty when it can. */
export function formProblems(f: ScanForm, today: string, takenFileIds: readonly string[] = []): string[] {
	const out: string[] = [];
	if (!f.file) out.push('Choose a file from the library.');
	else if (takenFileIds.includes(f.file.id)) out.push('This file is already a surface scan of this item.');
	if (!f.condition || !SCAN_CONDITIONS.includes(f.condition)) out.push('Choose the condition.');
	else if (f.condition === 'other' && !f.note.trim()) out.push('Say in the note what the condition is.');
	if (f.date && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) out.push('The date is not a date.');
	else if (f.date && f.date > today) out.push('The scan date cannot be in the future.');
	return out;
}

/** Today as YYYY-MM-DD in the browser's own calendar (what a date box holds). */
export function todayIso(now: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The operations to pick from: those run with the edge, or with any edge of the insert. */
export function operationFilter(target: { insertId?: string | null; edgeId?: string | null }): Record<string, unknown> {
	if (target.edgeId) return { insert_edge_id: { _eq: target.edgeId } };
	return { insert_edge_id: { insert_id: { _eq: target.insertId ?? '' } } };
}

/** The columns the operation picker reads (shared with the Inbox's form). */
export const OPERATION_FIELDS = ['operation_id', 'pass_code', 'operation_sequence', 'operation_date', 'process_category', 'sample_id.sample_code'];

/** One row of the operation picker: "S-0042 · pass 2 · Turning · 12 Oct 2026". */
export const operationOption = (o: any): { value: string; text: string } => ({
	value: String(o.operation_id),
	text: [operationLabel(o), processLabel(o.process_category), formatDate(o.operation_date)].filter(Boolean).join(' · '),
});
