// Linked data files of a record (the `data_files` M2M), as the d1-archive-links interface shows
// them: a file registered from the lab archive carries `metadata.archive_path`, which maps to a
// UNC path on the group share. A file without one was uploaded to Directus itself.

export const DEFAULT_UNC_PREFIX = '\\\\uosfstore.shef.ac.uk\\shared\\star_group1\\';

export interface LinkedFile {
	id: string;
	name: string;
	/**
	 * 'archive': lives on the group share; 'upload': stored in Directus; 'locked': the link exists but the reader may not see the file (the
	 * junction holds only its id): the page shows "a file from another person's folder" and nothing else, so `name` is empty.
	 */
	kind: 'archive' | 'upload' | 'locked';
	/**
	 * Where the row came from: 'data_files' (a Directus file linked through the record's data_files junction, so `id` is a directus_files id and the
	 * d1-inbox settings route can be asked about it) or 'share' (an operation_files row: `id` is the share link's own, never a directus_files id).
	 */
	source: 'data_files' | 'share';
	unc: string | null;
	folder: string | null;
	fileUri: string | null;
}

export function toUnc(archivePath: string, prefix = DEFAULT_UNC_PREFIX): string {
	return prefix + archivePath.replace(/\//g, '\\');
}

// strip the trailing filename
export function parentUnc(unc: string): string {
	return unc.replace(/\\[^\\]*$/, '');
}

// \\host\share\path  ->  file://host/share/path  (correct UNC file URI)
export function toFileUri(unc: string): string {
	const noLead = unc.replace(/^\\\\/, '').replace(/\\/g, '/');
	return 'file://' + encodeURI(noLead);
}

function metadataOf(file: any): Record<string, any> {
	const m = file?.metadata;
	if (typeof m === 'string') {
		try {
			return JSON.parse(m) ?? {};
		} catch {
			return {};
		}
	}
	return m || {};
}

// `links` are the junction rows of `data_files` read with
// `data_files.id` and `data_files.directus_files_id.{id,title,filename_download,metadata}`. A file Directus will not show the reader (ADR-0022: files
// belong to their provenance owner) comes back as `directus_files_id: null`: it is listed as `kind: 'locked'`, keyed by the junction row's own id.
export function linkedFiles(links: any[] | null | undefined, prefix = DEFAULT_UNC_PREFIX): LinkedFile[] {
	const out: LinkedFile[] = [];
	let hidden = 0;
	for (const l of links ?? []) {
		const f = l?.directus_files_id;
		// A file the reader may not see: under row filters Directus answers null for `directus_files_id.<field>` (see hiddenLinks.ts), and the column is
		// NOT NULL on all three junctions, so a junction row with null there is a hidden file. It is kept as a locked file: a link exists, nothing more is
		// known or shown. The row's own id (`data_files.id`) keys it; a row read without it gets a key of its own. A bare id string is the same, kept
		// as a fallback.
		if (l && typeof l === 'object' && f === null) {
			out.push({ id: l.id ? String(l.id) : `locked-${hidden++}`, name: '', kind: 'locked', source: 'data_files', unc: null, folder: null, fileUri: null });
			continue;
		}
		if (typeof f === 'string' && f !== '') {
			out.push({ id: f, name: '', kind: 'locked', source: 'data_files', unc: null, folder: null, fileUri: null });
			continue;
		}
		if (!f || typeof f !== 'object') continue;
		const archivePath: string = metadataOf(f).archive_path || '';
		const name = f.filename_download || f.title || archivePath.split('/').pop() || '(file)';
		if (!archivePath) {
			out.push({ id: String(f.id), name, kind: 'upload', source: 'data_files', unc: null, folder: null, fileUri: null });
			continue;
		}
		const unc = toUnc(archivePath, prefix);
		out.push({ id: String(f.id), name, kind: 'archive', source: 'data_files', unc, folder: parentUnc(unc), fileUri: toFileUri(unc) });
	}
	return out;
}

// `operation_files` rows: older links to a file on the network share, stored as a plain path
// (a UNC path or a mapped-drive path) instead of a Directus file. Shown the same way as an
// archive file, minus the open link (a bare path has no file:// form we can trust).
export function shareFiles(rows: any[] | null | undefined): LinkedFile[] {
	const out: LinkedFile[] = [];
	for (const r of rows ?? []) {
		const path = typeof r?.file_path === 'string' ? r.file_path.trim() : '';
		if (!path) continue;
		const folder = path.replace(/[\\/][^\\/]*$/, '');
		const base = path.split(/[\\/]/).pop() || path;
		out.push({
			id: String(r.file_id ?? path),
			name: r.file_name || base,
			kind: 'archive',
			source: 'share',
			unc: path,
			folder: folder === path ? null : folder,
			fileUri: null,
		});
	}
	return out;
}
