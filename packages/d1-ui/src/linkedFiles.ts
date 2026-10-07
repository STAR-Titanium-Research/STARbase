// Linked data files of a record (the `data_files` M2M), as the d1-archive-links interface shows
// them: a file registered from the lab archive carries `metadata.archive_path`, which maps to a
// UNC path on the group share. A file without one was uploaded to Directus itself.

export const DEFAULT_UNC_PREFIX = '\\\\uosfstore.shef.ac.uk\\shared\\star_group1\\';

export interface LinkedFile {
	id: string;
	name: string;
	/** 'archive': lives on the group share; 'upload': stored in Directus. */
	kind: 'archive' | 'upload';
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
// `data_files.directus_files_id.{id,title,filename_download,metadata}`.
export function linkedFiles(links: any[] | null | undefined, prefix = DEFAULT_UNC_PREFIX): LinkedFile[] {
	const out: LinkedFile[] = [];
	for (const l of links ?? []) {
		const f = l?.directus_files_id;
		if (!f || typeof f !== 'object') continue; // unreadable file: the junction holds only the id
		const archivePath: string = metadataOf(f).archive_path || '';
		const name = f.filename_download || f.title || archivePath.split('/').pop() || '(file)';
		if (!archivePath) {
			out.push({ id: String(f.id), name, kind: 'upload', unc: null, folder: null, fileUri: null });
			continue;
		}
		const unc = toUnc(archivePath, prefix);
		out.push({ id: String(f.id), name, kind: 'archive', unc, folder: parentUnc(unc), fileUri: toFileUri(unc) });
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
			unc: path,
			folder: folder === path ? null : folder,
			fileUri: null,
		});
	}
	return out;
}
