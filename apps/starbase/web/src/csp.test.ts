import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { starbaseCsp } from './csp';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe("STARbase's CSP", () => {
	it('is exactly what Caddy sends in production', () => {
		const caddy = readFileSync(join(repo, 'infra', 'caddy', 'Caddyfile'), 'utf8');
		const line = caddy.split('\n').find((l) => l.includes('header Content-Security-Policy'));
		expect(line, 'the :8090 site sends a CSP').toBeDefined();
		expect(line).toContain(`"${starbaseCsp('{$D1_SERVER_ORIGIN}')}"`);
	});
	it('lets the app reach and frame d1-server, and nothing else', () => {
		const csp = starbaseCsp('https://d1-server.tail54eeb6.ts.net');
		expect(csp).toContain("connect-src 'self' https://d1-server.tail54eeb6.ts.net");
		expect(csp).toContain("img-src 'self' data: blob: https://d1-server.tail54eeb6.ts.net");
		expect(csp).toContain('frame-src https://d1-server.tail54eeb6.ts.net');
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).not.toContain('*');
	});
	// Directus sends Cross-Origin-Opener-Policy: same-origin-allow-popups itself, which severs window.opener for the
	// edit page's new-tab fallback (the page posts "saved" back to STARbase). Caddy relaxes it for that
	// one path on the d1-server site, and nowhere else.
	it('relaxes COOP on /admin/d1-edit/* only, on the d1-server site', () => {
		const caddy = readFileSync(join(repo, 'infra', 'caddy', 'Caddyfile'), 'utf8');
		const code = caddy.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
		expect(code.match(/Cross-Origin-Opener-Policy/gi), 'one COOP directive in the whole Caddyfile').toHaveLength(1);
		// the handle block, closed by the first 4-space-indented brace; the header rides the upstream response
		const block = code.match(/^ {4}handle \/admin\/d1-edit\/\*\s*\{\n[\s\S]*?\n {4}\}/m);
		expect(block, 'a `handle /admin/d1-edit/*` block on the site').not.toBeNull();
		expect(block![0]).toContain('reverse_proxy directus:8055');
		expect(block![0]).toMatch(/header_down\s+Cross-Origin-Opener-Policy\s+unsafe-none/);
		// ... and that site is the :80 one (d1-server), not STARbase's :8090
		const sites = [...code.slice(0, block!.index).matchAll(/^(:\d+)\s*\{/gm)];
		expect(sites.at(-1)![1]).toBe(':80');
	});
	// A missing hashed bundle must be a plain 404. Falling through to the SPA's index.html would serve HTML as a
	// script with "immutable" caching, and a stale tab would keep it for a year.
	it('answers a missing /assets/* with a 404, and only falls back to index.html outside it', () => {
		const caddy = readFileSync(join(repo, 'infra', 'caddy', 'Caddyfile'), 'utf8');
		const code = caddy.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
		const site = code.slice(code.indexOf(':8090 {'));
		const assets = site.match(/^ {4}handle \/assets\/\*\s*\{\n[\s\S]*?\n {4}\}/m);
		expect(assets, 'a `handle /assets/*` block on the :8090 site').not.toBeNull();
		expect(assets![0]).not.toContain('try_files');
		expect(assets![0]).toContain('file_server');
		// immutable only for a file that exists (a matcher), never as a blanket header; a miss is not cached
		expect(assets![0]).toContain('@found file {path}');
		expect(assets![0]).toContain('header @found Cache-Control "public, max-age=31536000, immutable"');
		expect(assets![0]).not.toMatch(/^\s*header Cache-Control .*immutable/m);
		expect(assets![0]).toContain('header @missing Cache-Control no-store');
		const spa = site.match(/^ {4}handle \{\n[\s\S]*?\n {4}\}/m);
		expect(spa![0]).toContain('try_files {path} /index.html');
		expect(site.indexOf(assets![0])).toBeLessThan(site.indexOf(spa![0]));
	});
});
