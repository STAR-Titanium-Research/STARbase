// The object store behind d1-surface-scan: a read-only client for the S3 API that MinIO speaks (ADR-0006), kept in its own
// small module so the endpoint's tests can hand it a fake.
//
// It does one thing: GET one object under the `surface-scans/` prefix of the heavy-data bucket, as a stream. No dependency:
// Directus loads this folder as it is (no build step), and the S3 client its own storage driver uses is not importable from
// an extension, so the request is signed here (AWS Signature Version 4, path-style URL, an empty payload) and sent with fetch.
// Nothing here lists, writes or deletes, and a key outside the prefix is refused before any request is made.
//
// Settings (the names the workers already use; docker-compose.yml passes them to the Directus service):
//   MINIO_ENDPOINT        http://minio:9000
//   MINIO_ROOT_USER       access key
//   MINIO_ROOT_PASSWORD   secret key
//   MINIO_BUCKET          bucket of the heavy-data pipeline (default d1-files)
//   MINIO_REGION          optional, default us-east-1 (MinIO's default)

import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

export const PREFIX = 'surface-scans/';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const REQUEST_TIMEOUT_MS = 60_000;

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();

// AWS Signature Version 4 for one GET with no query string. Returns the headers to send (Host is set by fetch itself and is
// signed from the URL). `extraHeaders` (lower-case names) are signed as well. Exported for the test against AWS's published
// example.
export function signGet({ url, accessKey, secretKey, region = 'us-east-1', service = 's3', date = new Date(), extraHeaders = {} }) {
	const u = new URL(url);
	const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
	const day = amzDate.slice(0, 8);
	const headers = { ...extraHeaders, host: u.host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate };
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
	const signedHeaders = names.join(';');
	const canonicalRequest = ['GET', u.pathname, u.search.replace(/^\?/, ''), canonicalHeaders, signedHeaders, EMPTY_SHA256].join('\n');
	const scope = `${day}/${region}/${service}/aws4_request`;
	const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
	const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
	const out = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
	delete out.host; // fetch sets it from the URL
	return out;
}

// A key that stays under the prefix and is made of plain path segments, nothing that could climb out of it.
export function safeKey(key) {
	if (typeof key !== 'string' || !key.startsWith(PREFIX) || key.length > 300) return false;
	return key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && /^[A-Za-z0-9._-]+$/.test(seg));
}

// null when MinIO is not configured (the endpoint then answers 503 instead of failing mid-request).
export function createObjectStore(env, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
	const endpoint = String(env?.MINIO_ENDPOINT ?? '').trim().replace(/\/+$/, '');
	const accessKey = String(env?.MINIO_ROOT_USER ?? '');
	const secretKey = String(env?.MINIO_ROOT_PASSWORD ?? '');
	const bucket = String(env?.MINIO_BUCKET ?? 'd1-files').trim() || 'd1-files';
	const region = String(env?.MINIO_REGION ?? 'us-east-1').trim() || 'us-east-1';
	if (!/^https?:\/\//.test(endpoint) || !accessKey || !secretKey) return null;

	return {
		// -> { body: Readable, size: number | null }, or null when there is no such object. Anything else (MinIO down, a refused
		// signature) throws, and the endpoint answers 502.
		async get(key, { signal } = {}) {
			if (!safeKey(key)) throw new Error('object key outside the surface-scans prefix');
			const url = `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
			const headers = signGet({ url, accessKey, secretKey, region, date: now() });
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const res = await fetchImpl(url, {
				method: 'GET',
				headers,
				redirect: 'error',
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (res.status === 404) {
				await res.body?.cancel?.();
				return null;
			}
			if (!res.ok) {
				await res.body?.cancel?.();
				throw new Error(`object store answered ${res.status}`);
			}
			const length = Number(res.headers.get('content-length'));
			return { body: Readable.fromWeb(res.body), size: Number.isFinite(length) && length >= 0 ? length : null };
		},
	};
}
