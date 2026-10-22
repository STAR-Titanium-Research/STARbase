// The SHA-256 of an uploaded log's raw bytes, as lowercase hex: `conform_logs.source_sha256`. The browser looks it up
// before uploading, so the same file is never stored twice (the column is unique).
import { ConformLogError } from './channels';

/** Lowercase hex SHA-256 of the bytes. Needs `crypto.subtle`, which browsers offer on HTTPS and localhost only. */
export async function sha256Hex(buf: ArrayBuffer | ArrayBufferView): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new ConformLogError('This browser cannot check the file: open STARbase over HTTPS to upload a log.');
	const bytes = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
	const digest = await subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
