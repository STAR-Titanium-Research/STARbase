// Hand a file the page just built to the browser's download (a Blob behind a temporary link). No server involved.
export function saveFile(filename: string, mime: string, bytes: Uint8Array): void {
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	// The browser has started the download by the time the click returns; free the Blob a little later.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
