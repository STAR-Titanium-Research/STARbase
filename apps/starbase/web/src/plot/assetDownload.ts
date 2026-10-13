import type { AxiosInstance } from 'axios';

// Download a d1-server file WITHOUT leaving the page. The old way (navigate the tab to
// /assets/<id>?download) replaced the plotter with Directus's JSON error when the session had expired or
// the file was gone. This fetches through STARbase's credentialed client instead (so the session guard
// applies) and saves the bytes with a temporary <a download>, like the Force App does. The file is held
// in memory while it downloads, which is fine at .mat / csv sizes.

// The server's name for the file, from Content-Disposition (RFC 5987 `filename*` first). Only the last
// path segment is kept (either slash), and a bare `.` or `..` is no name. null when there is none.
export function filenameFromDisposition(header: string | undefined | null): string | null {
	if (!header) return null;
	const clean = (raw: string) => {
		const name = raw.split(/[\\/]/).pop()?.trim() ?? '';
		return name && name !== '.' && name !== '..' ? name : null;
	};
	const star = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header);
	if (star) {
		try {
			const name = clean(decodeURIComponent(star[1].trim()));
			if (name) return name;
		} catch { /* a malformed escape: fall through to plain filename */ }
	}
	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
	return plain ? clean(plain[1] ?? plain[2]) : null;
}

// A file extension for the few types the plotters download, used when the server's name is not readable
// (the browser only sees Content-Disposition once Directus exposes it, CORS_EXPOSED_HEADERS).
const EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'text/csv': 'csv',
	'application/octet-stream': 'bin',
	'application/x-matlab-data': 'mat',
	'application/matlab': 'mat',
};
export function extensionForType(type: string): string | null {
	return EXTENSIONS[type.split(';')[0].trim().toLowerCase()] ?? null;
}

export function saveBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	let a: { remove(): void } | null = null;
	let handedOver = false;
	try {
		const link = document.createElement('a');
		a = link;
		link.href = url;
		link.download = filename;
		link.rel = 'noopener';
		document.body.appendChild(link);
		link.click();
		handedOver = true;
	} finally {
		a?.remove();
		// After the browser has taken the file; at once if it never got it.
		if (handedOver) setTimeout(() => URL.revokeObjectURL(url), 10_000);
		else URL.revokeObjectURL(url);
	}
}

// Rejects when the request fails (expired session, missing file) or the answer is not a file: the caller
// decides how to tell the user.
export async function downloadAsset(api: AxiosInstance, fileId: string, save: (blob: Blob, filename: string) => void = saveBlob): Promise<void> {
	const res = await api.get(`/assets/${encodeURIComponent(fileId)}`, { params: { download: '' }, responseType: 'blob' });
	if (!(res.data instanceof Blob)) throw new Error('not a file');
	const header = (res.headers as Record<string, unknown> | undefined)?.['content-disposition'];
	const named = filenameFromDisposition(typeof header === 'string' ? header : undefined);
	const ext = extensionForType(res.data.type);
	save(res.data, named ?? (ext ? `${fileId}.${ext}` : fileId));
}
