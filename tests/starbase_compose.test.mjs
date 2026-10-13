// node --test tests/starbase_compose.test.mjs
// STARbase's compose wiring, checked with parse-only `docker compose config` under a throwaway project
// name (no container is created or touched). Skipped where docker is not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const SECRETS = ['POSTGRES_PASSWORD', 'MINIO_ROOT_PASSWORD', 'DIRECTUS_KEY', 'DIRECTUS_SECRET', 'DIRECTUS_ADMIN_PASSWORD', 'WORKER_WEBHOOK_SECRET', 'REDIS_PASSWORD'];
const STAR = 'https://starbase.tail54eeb6.ts.net';
let docker = true;
try {
	execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
	docker = false;
}

function config(extra, profile) {
	const env = join(mkdtempSync(join(tmpdir(), 'sb-compose-')), '.env');
	writeFileSync(env, [...SECRETS.map((v) => `${v}=x`), 'FORCE_APP_ORIGIN=http://localhost:5180', ...extra].join('\n') + '\n');
	const args = ['compose', '-p', 'd1-starbase-check', '--env-file', env, ...(profile ? ['--profile', profile] : []), 'config', '--format', 'json'];
	return JSON.parse(execFileSync('docker', args, { cwd: repo, encoding: 'utf8' }));
}

test('without STARBASE_ORIGIN nothing is added: no trailing comma, no extra origin, no starbase device', { skip: !docker }, () => {
	const c = config([]);
	assert.equal(c.services.directus.environment.CORS_ORIGIN, 'http://localhost:5180');
	assert.equal(c.services['filter-service'].environment.FILTER_CORS_ORIGINS, 'http://localhost:5180');
	assert.equal(c.services['diag-service'].environment.DIAG_CORS_ORIGINS, 'http://localhost:5180');
	assert.equal(c.services.directus.environment.CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS, "'self'");
	assert.equal(c.services.directus.environment.SESSION_COOKIE_SECURE, 'false');
	assert.equal(c.services.starbase, undefined);
});

test('with STARBASE_ORIGIN, the three CORS lists and the frame setting gain exactly that origin', { skip: !docker }, () => {
	const c = config([`STARBASE_ORIGIN=${STAR}`, `STARBASE_URL=${STAR}`, 'SESSION_COOKIE_SECURE=true'], 'starbase');
	assert.equal(c.services.directus.environment.CORS_ORIGIN, `http://localhost:5180,${STAR}`);
	assert.equal(c.services.directus.environment.CORS_CREDENTIALS, 'true');
	assert.equal(c.services['filter-service'].environment.FILTER_CORS_ORIGINS, `http://localhost:5180,${STAR}`);
	assert.equal(c.services['diag-service'].environment.DIAG_CORS_ORIGINS, `http://localhost:5180,${STAR}`);
	assert.equal(c.services.directus.environment.CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS, `'self' ${STAR}`);
	assert.equal(c.services.directus.environment.STARBASE_URL, STAR);
	assert.equal(c.services.directus.environment.SESSION_COOKIE_SECURE, 'true');
});

test('the starbase device: its own hostname and tag, serve config, state volume', { skip: !docker }, () => {
	const s = config([`STARBASE_ORIGIN=${STAR}`, 'STARBASE_TS_AUTHKEY=tskey-test'], 'starbase').services.starbase;
	assert.equal(s.environment.TS_HOSTNAME, 'starbase');
	assert.equal(s.environment.TS_EXTRA_ARGS, '--advertise-tags=tag:starbase');
	assert.equal(s.environment.TS_SERVE_CONFIG, '/config/starbase-serve.json');
	assert.ok(s.volumes.some((v) => v.target === '/var/lib/tailscale'));
});

test('the proxy serves the built STARbase on :8090 without publishing it', { skip: !docker }, () => {
	const p = config([]).services.proxy;
	assert.ok(p.volumes.some((v) => v.target === '/srv/starbase'));
	assert.ok(!(p.ports ?? []).some((x) => String(x.target) === '8090'));
	assert.equal(p.environment.D1_SERVER_ORIGIN, 'https://d1-server.tail54eeb6.ts.net');
});
