import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Step 0's layout (spec §9, run 2), kept: starbase.<tailnet> and d1-server.<tailnet> mapped to this machine
// in the test browser, each over HTTPS with a throwaway certificate, so cookies are tested across HOSTS
// (ports alone prove nothing: cookies ignore ports) and Directus's cookie can be Secure.
//   https://starbase.<tailnet>:5191  → http://127.0.0.1:5190  (vite preview; Host rewritten, it checks it)
//   https://d1-server.<tailnet>:18443 → http://127.0.0.1:18057 (the preview Directus; headers as sent)
export const TAILNET = 'tail54eeb6.ts.net';
export const STAR_HOST = `starbase.${TAILNET}`;
export const D1_HOST = `d1-server.${TAILNET}`;
export const HOSTS_LAUNCH_ARGS = [`--host-resolver-rules=MAP *.${TAILNET} 127.0.0.1`, '--ignore-certificate-errors'];

export function throwawayCert(): { key: Buffer; cert: Buffer } {
	const dir = mkdtempSync(join(tmpdir(), 'starbase-cert-'));
	execFileSync(
		'openssl',
		['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=starbase-e2e', '-addext', `subjectAltName=DNS:${STAR_HOST},DNS:${D1_HOST}`,
			'-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2'],
		{ stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
	);
	return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

export interface ProxyOptions {
	listenPort: number;
	targetPort: number;
	rewriteHost: boolean;
	tls: { key: Buffer; cert: Buffer };
}

// node:https in front of a local http server; every header, Set-Cookie included, passed through both ways.
export function startHttpsProxy(o: ProxyOptions): Promise<https.Server> {
	const server = https.createServer(o.tls, (req, res) => {
		const headers = o.rewriteHost ? { ...req.headers, host: `127.0.0.1:${o.targetPort}` } : req.headers;
		const upstream = http.request({ host: '127.0.0.1', port: o.targetPort, method: req.method, path: req.url, headers }, (ur) => {
			const pairs: [string, string][] = [];
			for (let i = 0; i < ur.rawHeaders.length; i += 2) pairs.push([ur.rawHeaders[i], ur.rawHeaders[i + 1]]);
			res.writeHead(ur.statusCode ?? 502, pairs as unknown as http.OutgoingHttpHeaders);
			ur.pipe(res);
		});
		upstream.on('error', (e) => {
			res.statusCode = 502;
			res.end(String(e));
		});
		req.pipe(upstream);
	});
	return new Promise((resolve) => server.listen(o.listenPort, '127.0.0.1', () => resolve(server)));
}

export async function startHostsLayout(): Promise<{ close(): Promise<void> }> {
	const tls = throwawayCert();
	const servers = [
		await startHttpsProxy({ listenPort: 5191, targetPort: 5190, rewriteHost: true, tls }),
		await startHttpsProxy({ listenPort: 18443, targetPort: 18057, rewriteHost: false, tls }),
	];
	return {
		close: async () => {
			for (const s of servers) {
				s.closeAllConnections();
				await new Promise<void>((r) => s.close(() => r()));
			}
		},
	};
}
