// node --test scripts/deploy/*.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	LOCK_FRESH_MS,
	acquireRunLock,
	buildServicesFromConfig,
	formatRunId,
	lockIsLive,
	makeExec,
	makeLockFs,
	migrateUpSection,
	missingEnvKeys,
	overlap,
	parseBackupName,
	parseComposePs,
	parseEnv,
	parseMergeTree,
	parsePending,
	parsePendingFiles,
	parsePorcelainZ,
	planSteps,
	releaseRunLock,
	rewriteDbUrl,
	runIdToDate,
	scanDestructive,
	serviceProblems,
	startHeartbeat,
	stripSql,
} from './lib.mjs';

test('planSteps maps changed paths to steps in execution order', () => {
	assert.deepEqual(planSteps(['docs/x.md', 'README.md']), []);
	assert.deepEqual(planSteps(['db/migrations/202610180900_x.sql']), ['migrate']);
	assert.deepEqual(planSteps(['package-lock.json']), ['install']);
	assert.deepEqual(planSteps(['apps/other/package.json']), ['install']);
	assert.deepEqual(planSteps(['apps/force-app/web/package.json']), ['install', 'build:web', 'recreate:proxy']);
	assert.deepEqual(planSteps(['core/extensions/foo/index.js']), ['build:extensions', 'recreate:directus']);
	assert.deepEqual(planSteps(['apps/starbase/src/a.vue']), ['build:starbase', 'recreate:proxy']);
	assert.deepEqual(planSteps(['packages/force-plotting/src/a.ts']), ['build:web', 'recreate:proxy']);
	// packages/d1-ui feeds both the extensions and STARbase
	assert.deepEqual(planSteps(['packages/d1-ui/a.vue']), ['build:extensions', 'build:starbase', 'recreate:directus', 'recreate:proxy']);
	assert.deepEqual(planSteps(['docker-compose.yml']), ['compose-up']);
	assert.deepEqual(planSteps(['scripts/inbox_crawler/crawl.py']), ['recreate:inbox-crawler']);
	assert.deepEqual(planSteps(['.env.example']), []);
	assert.deepEqual(
		planSteps(['core/extensions/a/index.js', 'db/migrations/1.sql', 'package.json', 'apps/starbase/x.js', 'docker-compose.yml']),
		['migrate', 'install', 'build:extensions', 'build:starbase', 'compose-up', 'recreate:directus', 'recreate:proxy'],
	);
	// a path merely starting with the same letters is not under the directory
	assert.deepEqual(planSteps(['apps/starbase-old/x.js']), []);
});

test('planSteps adds recreate:<service> for build services whose directory changed', () => {
	const svcs = [
		{ service: 'heavy-data-worker', dir: 'plugins/heavy-data-worker/', profiles: [] },
		{ service: 'diag', dir: 'plugins/diag-service/', profiles: [] },
	];
	assert.deepEqual(planSteps(['plugins/heavy-data-worker/app.py'], svcs), ['recreate:heavy-data-worker']);
	assert.deepEqual(planSteps(['plugins/diag-service/Dockerfile', 'plugins/heavy-data-worker/x'], svcs), ['recreate:heavy-data-worker', 'recreate:diag']);
	assert.deepEqual(planSteps(['plugins/other/x'], svcs), []);
});

test('buildServicesFromConfig: context directory, or the Dockerfile directory when the context is the repo root', () => {
	const root = path.resolve('/repo');
	const cfg = {
		services: {
			directus: { image: 'x' },
			a: { build: { context: path.join(root, 'plugins', 'a'), dockerfile: 'Dockerfile' } },
			diag: { build: { context: root, dockerfile: 'plugins/diag-service/Dockerfile' } },
			gated: { build: { context: path.join(root, 'plugins', 'g') }, profiles: ['archive'] },
			rel: { build: 'apps/rel' },
		},
	};
	assert.deepEqual(buildServicesFromConfig(cfg, root), [
		{ service: 'a', dir: 'plugins/a/', profiles: [] },
		{ service: 'diag', dir: 'plugins/diag-service/', profiles: [] },
		{ service: 'gated', dir: 'plugins/g/', profiles: ['archive'] },
		{ service: 'rel', dir: 'apps/rel/', profiles: [] },
	]);
});

test('overlap is the dirty files the update also changes', () => {
	assert.deepEqual(overlap(['a', 'b', 'c'], ['b', 'c', 'd']), ['b', 'c']);
	assert.deepEqual(overlap([], ['x']), []);
	assert.deepEqual(overlap(['a'], []), []);
});

test('parsePorcelainZ reads paths, renames and spaces', () => {
	const out = ' M docker-compose.yml\0M  a b/c.txt\0R  new.txt\0old.txt\0';
	assert.deepEqual(parsePorcelainZ(out), ['docker-compose.yml', 'a b/c.txt', 'new.txt', 'old.txt']);
	assert.deepEqual(parsePorcelainZ(''), []);
});

test('parseMergeTree: clean, conflicted, and unknown (old git)', () => {
	assert.deepEqual(parseMergeTree({ code: 0, stdout: 'abc123\n' }), []);
	assert.deepEqual(
		parseMergeTree({ code: 1, stdout: 'abc123\nfoo/a.js\nb.txt\n\nAuto-merging foo/a.js\nCONFLICT (content): Merge conflict in foo/a.js\n' }),
		['foo/a.js', 'b.txt'],
	);
	assert.equal(parseMergeTree({ code: 129, stdout: '' }), null);
});

test('parseEnv / missingEnvKeys / rewriteDbUrl / parsePending / parseBackupName', () => {
	assert.deepEqual(parseEnv('A=1\n# B=2\nC="x y"\r\nexport D=\'q\'\n\nbad line\n'), { A: '1', C: 'x y', D: 'q' });
	assert.deepEqual(missingEnvKeys('A=1\n# B=2\nC=3\nD=4\n', 'A=9\nD=\n'), ['C']);
	assert.equal(rewriteDbUrl('postgres://d1:pw@localhost:5432/d1_database?sslmode=disable'), 'postgres://d1:pw@postgres:5432/d1_database?sslmode=disable');
	assert.equal(rewriteDbUrl('postgres://d1:pw@127.0.0.1:5433/db'), 'postgres://d1:pw@postgres:5432/db');
	assert.equal(rewriteDbUrl('postgres://d1:pw@postgres:5432/db'), 'postgres://d1:pw@postgres:5432/db');
	assert.equal(parsePending('[X] a.sql\n[ ] b.sql\n\nApplied: 1\nPending: 1\n'), 1);
	assert.equal(parsePending('[X] a.sql\n\nApplied: 1\nPending: 0\n'), 0);
	assert.equal(parsePending('[ ] a.sql\n[ ] b.sql\n'), 2);
	assert.equal(parseBackupName('  Local copy : ./backups/d1_20261018_1200.sql.gz\n  Roles : x'), 'd1_20261018_1200.sql.gz');
	assert.equal(parseBackupName('nothing'), null);
});

test('parseComposePs reads NDJSON and arrays', () => {
	assert.deepEqual(parseComposePs('{"Service":"a"}\n{"Service":"b"}\n').map((r) => r.Service), ['a', 'b']);
	assert.deepEqual(parseComposePs('[{"Service":"a"}]').map((r) => r.Service), ['a']);
	assert.deepEqual(parseComposePs(''), []);
});

test('run ids round-trip', () => {
	const d = new Date(Date.UTC(2026, 9, 18, 9, 5, 7));
	assert.equal(formatRunId(d), '20261018T090507Z');
	assert.equal(runIdToDate('20261018T090507Z').getTime(), d.getTime());
	assert.equal(runIdToDate('nope'), null);
});

test('migrateUpSection takes only the up section', () => {
	const sql = '-- migrate:up\nCREATE TABLE a();\n-- migrate:down\nDROP TABLE a;\n';
	assert.match(migrateUpSection(sql), /CREATE TABLE a/);
	assert.doesNotMatch(migrateUpSection(sql), /DROP/);
	assert.match(migrateUpSection('-- migrate:up transaction:false\nSELECT 1;'), /SELECT 1/);
});

test('stripSql removes comments and blanks literals', () => {
	assert.doesNotMatch(stripSql('SELECT 1; -- DROP TABLE x\nSELECT 2;'), /DROP/);
	assert.doesNotMatch(stripSql('/* DROP TABLE x */ SELECT 1; /* a /* nested DELETE FROM y */ still */ SELECT 2;'), /DROP|DELETE|still/);
	assert.doesNotMatch(stripSql("COMMENT ON TABLE t IS 'we DROP TABLE nothing';"), /DROP/);
	// a '--' inside a string is not a comment: what follows on the line is still code
	assert.match(stripSql("SELECT '--'; DROP TABLE x;"), /DROP TABLE x/);
	assert.match(stripSql("SELECT 'it''s -- fine'; DELETE FROM y;"), /DELETE FROM y/);
});

test('scanDestructive finds each destructive kind in the up section', () => {
	const up = (body) => `-- migrate:up\n${body}\n-- migrate:down\nSELECT 1;\n`;
	assert.deepEqual(scanDestructive(up('CREATE TABLE a(id int); ALTER TABLE a ADD COLUMN b int;')), []);
	assert.deepEqual(scanDestructive(up('DROP TABLE a;')), ['DROP TABLE']);
	assert.deepEqual(scanDestructive(up('drop table if exists a;')), ['DROP TABLE']);
	assert.deepEqual(scanDestructive(up('ALTER TABLE a DROP COLUMN b;')), ['DROP COLUMN']);
	assert.deepEqual(scanDestructive(up('DROP SCHEMA s CASCADE; DROP TYPE t; DROP FUNCTION f(); DROP VIEW v; DROP INDEX i;')), [
		'DROP SCHEMA',
		'DROP TYPE',
		'DROP FUNCTION',
		'DROP VIEW',
		'DROP INDEX',
	]);
	assert.deepEqual(scanDestructive(up('DROP MATERIALIZED VIEW v;')), ['DROP VIEW']);
	assert.deepEqual(scanDestructive(up('TRUNCATE a;')), ['TRUNCATE']);
	assert.deepEqual(scanDestructive(up('DELETE FROM a WHERE x;')), ['DELETE FROM']);
	assert.deepEqual(scanDestructive(up('UPDATE a\n  SET x = 1;')), ['UPDATE … SET']);
	assert.deepEqual(scanDestructive(up('ALTER TABLE a DROP CONSTRAINT c;')), ['ALTER … DROP']);
	assert.deepEqual(scanDestructive(up('ALTER TABLE a ALTER COLUMN b DROP NOT NULL;')), ['ALTER … DROP']);
});

test('scanDestructive ignores the down section, comments and text in strings', () => {
	const sql = [
		'-- migrate:up',
		'-- DROP TABLE nothing (explains why)',
		'/* DELETE FROM x; TRUNCATE y; */',
		"COMMENT ON COLUMN a.b IS 'UPDATE c SET d, DROP TABLE e';",
		'CREATE TABLE ok(id int);',
		'-- migrate:down',
		'DROP TABLE ok;',
		'DELETE FROM ok;',
	].join('\n');
	assert.deepEqual(scanDestructive(sql), []);
});

test('scanDestructive: a foreign key ON UPDATE action is not an UPDATE statement', () => {
	const sql = '-- migrate:up\nALTER TABLE a ADD FOREIGN KEY (b) REFERENCES c(id) ON UPDATE SET NULL ON DELETE SET NULL;\n';
	assert.deepEqual(scanDestructive(sql), []);
});

test('scanDestructive does not let a quoted "--" hide a later statement', () => {
	assert.deepEqual(scanDestructive("-- migrate:up\nSELECT '--'; DROP TABLE x;\n"), ['DROP TABLE']);
});

test('serviceProblems', () => {
	const rows = [
		{ Service: 'directus', State: 'running', Health: 'healthy' },
		{ Service: 'proxy', State: 'running', Health: '' },
		{ Service: 'worker', State: 'running', Health: 'starting' },
		{ Service: 'init', State: 'exited', ExitCode: 0 },
		{ Service: 'bad', State: 'restarting' },
		// stopped on purpose or failed one-shots: never a deploy failure
		{ Service: 'ollama', State: 'exited', ExitCode: 137 },
		{ Service: 'archive-indexer', State: 'exited', ExitCode: 1 },
		{ Service: 'created-one', State: 'created' },
	];
	assert.deepEqual(serviceProblems(rows, ['directus', 'proxy']), []);
	assert.deepEqual(serviceProblems(rows, ['worker', 'missing']), ['worker: running (starting)', 'missing: not running']);
	assert.deepEqual(serviceProblems(rows, ['directus'], true), ['worker: running (starting)', 'bad: restarting']);
});

// ---- the real process runner (spawns node itself only; never git, docker or npm) --------------

test('makeExec runs a command without a shell: arguments with spaces stay single arguments', async () => {
	const exec = makeExec();
	const chunks = [];
	const r = await exec(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b c', '--x=1 2', '$HOME; echo hi'], { onData: (c) => chunks.push(c) });
	assert.equal(r.code, 0);
	assert.deepEqual(JSON.parse(r.stdout), ['a b c', '--x=1 2', '$HOME; echo hi']);
	assert.equal(chunks.join(''), r.stdout);
});

test('makeExec reports exit codes, stderr, a missing program and timeouts without rejecting', async () => {
	const exec = makeExec();
	const bad = await exec(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']);
	assert.equal(bad.code, 3);
	assert.match(bad.stderr, /boom/);

	const missing = await exec('definitely-not-a-program-xyz', []);
	assert.equal(missing.code, -1);

	const slow = await exec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 });
	assert.equal(slow.code, -2);
	assert.match(slow.stderr, /timed out/);
});

test('makeExec passes env and cwd', async () => {
	const exec = makeExec();
	const r = await exec(process.execPath, ['-e', 'console.log(process.env.DEPLOY_T + "|" + process.cwd())'], { env: { ...process.env, DEPLOY_T: 'x y' }, cwd: path.resolve('.') });
	assert.equal(r.stdout.trim(), `x y|${path.resolve('.')}`);
});

test('parsePendingFiles lists the pending migrations of a dbmate status', () => {
	assert.deepEqual(parsePendingFiles('[X] 1_a.sql\n[ ] 2_b.sql\n[ ] 3_c.sql\n\nApplied: 1\nPending: 2\n'), ['2_b.sql', '3_c.sql']);
	assert.deepEqual(parsePendingFiles('[X] 1_a.sql\n'), []);
});

test('parseMergeTree understands the -z (NUL separated) form', () => {
	const NUL = '\u0000';
	assert.deepEqual(parseMergeTree({ code: 1, stdout: `oid${NUL}a b/c.js${NUL}d.txt${NUL}${NUL}Auto-merging a b/c.js${NUL}` }), ['a b/c.js', 'd.txt']);
	assert.deepEqual(parseMergeTree({ code: 0, stdout: `oid${NUL}` }), []);
});

// ---- run lock ----------------------------------------------------------------------------------

const tmpLock = () => path.join(mkdtempSync(path.join(tmpdir(), 'lock test ')), 'logs', 'deploy', '.lock');

test('lockIsLive needs a live process AND a recently refreshed file', () => {
	const now = 1_000_000_000;
	const alive = () => true;
	const lock = { id: 'r1', pid: 500 };
	assert.equal(lockIsLive(lock, now - 1000, { isAlive: alive, nowMs: now }), true);
	assert.equal(lockIsLive(lock, now - 1000, { isAlive: () => false, nowMs: now }), false, 'process gone');
	assert.equal(lockIsLive(lock, now - LOCK_FRESH_MS - 1, { isAlive: alive, nowMs: now }), false, 'pid reused: nobody refreshes the file');
	assert.equal(lockIsLive(null, now, { isAlive: alive, nowMs: now }), false);
	assert.equal(lockIsLive({ id: 'r1' }, now, { isAlive: alive, nowMs: now }), false, 'no pid');
	// our own pid: only for runs this process started
	assert.equal(lockIsLive({ id: 'r1', pid: 9 }, now, { isAlive: alive, nowMs: now, ownPid: 9, ownRunIds: new Set() }), false);
	assert.equal(lockIsLive({ id: 'r1', pid: 9 }, now, { isAlive: alive, nowMs: now, ownPid: 9, ownRunIds: new Set(['r1']) }), true);
});

test('acquireRunLock: exclusive create, live holder refused, stale lock replaced (real files)', () => {
	const lockfs = makeLockFs(tmpLock());
	assert.deepEqual(acquireRunLock(lockfs, { id: 'a', pid: 111 }), { ok: true });
	assert.equal(lockfs.read().lock.id, 'a');

	const refused = acquireRunLock(lockfs, { id: 'b', pid: 222 }, { isAlive: (p) => p === 111 });
	assert.equal(refused.ok, false);
	assert.equal(refused.holder.id, 'a');
	assert.equal(lockfs.read().lock.id, 'a', 'untouched');

	const stale = [];
	const took = acquireRunLock(lockfs, { id: 'c', pid: 333 }, { isAlive: () => false, onStale: (l) => stale.push(l.id) });
	assert.deepEqual(took, { ok: true });
	assert.deepEqual(stale, ['a']);
	assert.equal(lockfs.read().lock.id, 'c');
});

test('acquireRunLock treats a damaged lock file as stale', () => {
	const p = tmpLock();
	const lockfs = makeLockFs(p);
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, '{not json');
	assert.deepEqual(acquireRunLock(lockfs, { id: 'x', pid: 1 }, { isAlive: () => true }), { ok: true });
});

test('a lock last refreshed long ago is stale even though its pid is "alive" (pid reuse)', () => {
	const p = tmpLock();
	const lockfs = makeLockFs(p);
	acquireRunLock(lockfs, { id: 'old', pid: 111 });
	const old = new Date(Date.now() - 2 * LOCK_FRESH_MS);
	utimesSync(p, old, old);
	assert.deepEqual(acquireRunLock(lockfs, { id: 'new', pid: 222 }, { isAlive: () => true }), { ok: true });
	assert.equal(lockfs.read().lock.id, 'new');
});

test('releaseRunLock removes only its own lock; startHeartbeat refreshes it', async () => {
	const p = tmpLock();
	const lockfs = makeLockFs(p);
	acquireRunLock(lockfs, { id: 'mine', pid: 1 });
	releaseRunLock(lockfs, 'someone-else');
	assert.ok(lockfs.read());
	const old = new Date(Date.now() - 10 * 60_000);
	utimesSync(p, old, old);
	const stop = startHeartbeat(lockfs, 'mine', 10);
	await new Promise((r) => setTimeout(r, 60));
	stop();
	assert.ok(Date.now() - lockfs.read().mtimeMs < 60_000);
	releaseRunLock(lockfs, 'mine');
	assert.equal(lockfs.read(), null);
});
