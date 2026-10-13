import type { AxiosInstance } from 'axios';

// Download a d1-server file WITHOUT leaving the page. The old way (navigate the tab to
// /assets/<id>?download) replaced the plotter with Directus's JSON error when the session had expired or
// the file was gone. This fetches through STARbase's credentialed client instead (so the session guard
// applies) and saves the bytes with a temporary <a download>, like the Force App does. The file is held
// in memory while it downloads, which is fine at .mat / csv sizes.

// The server's name for the file, from Content-Disposition (RFC 5987 `filename*` first). Only the last
// path segment is kept. null when there is none.
export function filenameFromDisposition(header: string | undefined | null): string | null {
	if (!header) return null;
	const clean = (raw: string) => {
		const name = raw.split(/[\/]/).pop()?.trim() ?? '';
		return name || null;
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

export function saveBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000); // after the browser has taken the file
}

// Rejects when the request fails (expired session, missing file): the caller decides how to tell the user.
export async function downloadAsset(api: AxiosInstance, fileId: string, save: (blob: Blob, filename: string) => void = saveBlob): Promise<void> {
	const res = await api.get(`/assets/${encodeURIComponent(fileId)}`, { params: { download: '' }, responseType: 'blob' });
	const header = (res.headers as Record<string, unknown> | undefined)?.['content-disposition'];
	save(res.data as Blob, filenameFromDisposition(typeof header === 'string' ? header : undefined) ?? fileId);
}
