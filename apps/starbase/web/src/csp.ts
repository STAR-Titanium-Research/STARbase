// STARbase's Content-Security-Policy, in one place. Caddy sends it in production (infra/caddy/Caddyfile;
// csp.test.ts checks they match) and `vite preview` sends it for the end-to-end run, so the tests see
// what the lab sees. `d1` is d1-server's origin: the API, /filter, /diag, /octrees, the asset thumbnails
// and the framed edit form all live there.
export function starbaseCsp(d1: string): string {
	return [
		"default-src 'self'",
		`connect-src 'self' ${d1}`,
		`img-src 'self' data: blob: ${d1}`,
		`frame-src ${d1}`,
		// Vue's style bindings and the label preview (a srcdoc frame, which inherits this CSP) set inline styles.
		"style-src 'self' 'unsafe-inline'",
		"script-src 'self'",
		"font-src 'self' data:",
		// three.js and potree may start workers from blobs.
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
	].join('; ');
}
