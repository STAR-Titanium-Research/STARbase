// node --test scripts/deploy/*.test.mjs
// The orchestrator against a fake process runner: no test calls real git, docker or npm.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { computeCheck, main, parseArgs, runDeploy } from './deploy.mjs';

const REPO = path.resolve('/repo');
const NUL = '\0';

const ENV_TEXT = 'DATABASE_URL=postgres://d1:pw@localhost:5432/d1_database?sslmode=disable\nPOSTGRES_PASSWORD=x\n';
const ENV_EXAMPLE = 'DATABASE_URL=\nPOSTGRES_PASSWORD=\nDEPLOY_AGENT_TOKEN=\n# DEPLOY_BASH=x\n';

const COMPOSE_CONFIG = JSON.stringify({
	services: {
		directus: { image: 'directus' },
		proxy: { image: 'caddy' },
		'heavy-data-worker': { build: { context: path.join(REPO, 'plugins', 'heavy-data-worker'), dockerfile: 'Dockerfile' } },
		'surface-scan-worker': { build: { context: path.join(REPO, 'plugins', 'surface-scan-worker') }, profiles: ['archive'] },
	},
});

const MIGRATION_FILE = 'db/migrations/202610180900_add_thing.sql';
const SAFE_SQL = '-- migrate:up\nCREATE TABLE thing(id int);\n-- migrate:down\nDROP TABLE thing;\n';
const DESTRUCTIVE_SQL = '-- migrate:up\nALTER TABLE thing DROP COLUMN old;\n-- migrate:down\nSELECT 1;\n';

/**
 * A scripted world. `s` overrides: changed (paths), sql, dirty, mergeTree {code,stdout}, mergeCode, pending,
 * psRows (array or function(n) for the n-th ps call), backupCode, etc.
 */
function world(s = {}) {
	const calls = [];
	let t = 1_760_000_000_000;
	let psCalls = 0;
	const changed = s.changed ?? ['core/extensions/a/index.js'];
	const files = new Map([
		[path.join(REPO, '.env'), s.envText ?? ENV_TEXT],
		[path.join(REPO, '.env.example'), s.envExample ?? ENV_EXAMPLE],
	]);
	const written = new Map();
	const fsx = {
		readText: (p) => files.get(p) ?? null,
		writeText: (p, text) => written.set(p, text),
	};
	const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
	const exec = async (cmd, args, opts = {}) => {
		calls.push({ cmd, args, opts });
		t += 5;
		const k = `${cmd} ${args.join(' ')}`;
		if (k === 'git fetch -q origin') return s.fetch ?? ok();
		if (k === 'git rev-parse --abbrev-ref HEAD') return ok(`${s.branch ?? 'feat/x'}\n`);
		if (k === 'git rev-parse --short=8 HEAD') return ok(calls.some((c) => c.args.join(' ') === 'merge --no-edit origin/main') && !s.mergeCode ? 'bbbbbbbb\n' : 'aaaaaaaa\n');
		if (k === 'git rev-parse --short=8 origin/main') return ok('bbbbbbbb\n');
		if (k.startsWith('git log --format=')) return ok(s.upToDate ? '' : `${'1'.repeat(40)}\tfeat: one\n${'2'.repeat(40)}\tfix: two\n`);
		if (k.startsWith('git status --porcelain -z --untracked-files=no -- package-lock.json')) return ok(s.lockDirtyAfterInstall ? ` M package-lock.json${NUL}` : '');
		if (k.startsWith('git status --porcelain')) return ok((s.dirty ?? []).map((f) => ` M ${f}${NUL}`).join(''));
		if (k.startsWith('git diff --name-only -z --diff-filter=AM')) return ok(changed.filter((f) => f.startsWith('db/migrations/')).map((f) => f + NUL).join(''));
		if (k === 'git diff --name-only -z HEAD...origin/main') return ok(changed.map((f) => f + NUL).join(''));
		if (k.startsWith('git diff --name-only -z --diff-filter=U')) return ok(s.conflicted ? s.conflicted.map((f) => f + NUL).join('') : '');
		if (k.startsWith('git show origin/main:')) return ok(s.sql ?? SAFE_SQL);
		if (k.startsWith('git merge-tree')) return s.mergeTree ?? { code: 0, stdout: 'treeoid\n', stderr: '' };
		if (k === 'git merge --no-edit origin/main') return s.mergeCode ? { code: s.mergeCode, stdout: 'CONFLICT', stderr: '' } : ok('Merge made');
		if (cmd === 'docker' && args.join(' ').startsWith('compose --profile * config')) return s.composeConfigFail ? { code: 1, stdout: '', stderr: 'bad interpolation' } : ok(COMPOSE_CONFIG);
		if (cmd === 'docker' && args[0] === 'run') {
			const tail = args.slice(args.indexOf('ghcr.io/amacneil/dbmate:2') + 1).join(' ');
			if (tail === 'status') return ok(`[X] a.sql\n[ ] b.sql\n\nApplied: 1\nPending: ${s.pending ?? 1}\n`);
			if (tail === '--no-dump-schema up') return s.upCode ? { code: s.upCode, stdout: '', stderr: 'boom' } : ok('Applying: b.sql\n');
		}
		if (/bash(\.exe)?$/.test(cmd) && args[0] === 'infra/backup/backup.sh') {
			return s.backupCode ? { code: s.backupCode, stdout: '', stderr: 'no minio' } : ok('  Local copy : ./backups/d1_20261018_1200.sql.gz\n');
		}
		if (k === 'npm install --no-audit --no-fund') return s.installCode ? { code: s.installCode, stdout: '', stderr: '' } : ok();
		if (cmd === 'npm' && args[0] === 'run') return s.buildCode ? { code: s.buildCode, stdout: '', stderr: '' } : ok();
		if (cmd === 'docker' && args.includes('ps')) {
			psCalls++;
			const rows = typeof s.psRows === 'function' ? s.psRows(psCalls) : (s.psRows ?? [
				{ Service: 'directus', State: 'running', Health: 'healthy' },
				{ Service: 'proxy', State: 'running', Health: '' },
				{ Service: 'heavy-data-worker', State: 'running', Health: '' },
			]);
			return ok(rows.map((r) => JSON.stringify(r)).join('\n'));
		}
		return ok();
	};
	const out = [];
	const ctx = {
		exec,
		repoDir: REPO,
		env: s.processEnv ?? {},
		fsx,
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
		out: (x) => out.push(x),
		onData: (x) => out.push(x),
	};
	const seen = (prefix) => calls.filter((c) => `${c.cmd} ${c.args.join(' ')}`.startsWith(prefix));
	const keys = () => calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
	return { ctx, calls, out, written, files, seen, keys };
}

const stepNames = (r) => r.steps.map((x) => x.name);

test('check: up to date changes nothing and lists nothing', async () => {
	const w = world({ upToDate: true });
	const c = await computeCheck(w.ctx);
	assert.equal(c.upToDate, true);
	assert.deepEqual(c.commits, []);
	assert.deepEqual(c.steps, []);
	assert.equal(c.branch, 'feat/x');
	assert.equal(c.head, 'aaaaaaaa');
	assert.equal(c.target, 'bbbbbbbb');
	assert.deepEqual(w.keys(), [
		'git fetch -q origin',
		'git rev-parse --abbrev-ref HEAD',
		'git rev-parse --short=8 HEAD',
		'git rev-parse --short=8 origin/main',
		'git log --format=%H%x09%s HEAD..origin/main',
		'git status --porcelain -z --untracked-files=no',
	]);
});

test('check: commits, steps, migrations with a destructive statement needing an ack', async () => {
	const w = world({ changed: ['core/extensions/a/index.js', MIGRATION_FILE, 'package.json', 'plugins/heavy-data-worker/app.py'], sql: DESTRUCTIVE_SQL });
	const c = await computeCheck(w.ctx);
	assert.equal(c.upToDate, false);
	assert.deepEqual(c.commits, [
		{ sha: '11111111', subject: 'feat: one' },
		{ sha: '22222222', subject: 'fix: two' },
	]);
	assert.equal(c.changedCount, 4);
	assert.deepEqual(c.steps, ['migrate', 'install', 'build:extensions', 'recreate:directus', 'recreate:heavy-data-worker']);
	assert.deepEqual(c.migrations, [{ file: MIGRATION_FILE, destructive: ['DROP COLUMN'] }]);
	assert.deepEqual(c.needsAck, [MIGRATION_FILE]);
	assert.deepEqual(c.blockers, []);
	assert.deepEqual(c.conflicts, []);
});

test('check: overlap with uncommitted edits is a blocker', async () => {
	const w = world({ changed: ['docker-compose.yml', 'README.md'], dirty: ['docker-compose.yml', 'unrelated.txt'] });
	const c = await computeCheck(w.ctx);
	assert.deepEqual(c.dirty, ['docker-compose.yml', 'unrelated.txt']);
	assert.deepEqual(c.overlap, ['docker-compose.yml']);
	assert.equal(c.blockers.length, 1);
	assert.equal(c.blockers[0].code, 'overlap');
	assert.match(c.blockers[0].message, /docker-compose\.yml/);
});

test('check: merge conflicts are a blocker; old git reports conflicts as null and claims nothing', async () => {
	let w = world({ mergeTree: { code: 1, stdout: 'oid\ncore/extensions/foo/index.js\n\nCONFLICT (content)', stderr: '' } });
	let c = await computeCheck(w.ctx);
	assert.deepEqual(c.conflicts, ['core/extensions/foo/index.js']);
	assert.equal(c.blockers[0].code, 'conflict');

	w = world({ mergeTree: { code: 129, stdout: '', stderr: 'usage' } });
	c = await computeCheck(w.ctx);
	assert.equal(c.conflicts, null);
	assert.deepEqual(c.blockers, []);
});

test('check: an unreadable compose file blocks (the services to rebuild cannot be known)', async () => {
	const c = await computeCheck(world({ composeConfigFail: true }).ctx);
	assert.equal(c.blockers[0].code, 'compose_config');
});

test('check never merges, migrates, builds or restarts', async () => {
	const w = world({ changed: [MIGRATION_FILE, 'package.json', 'core/extensions/a/i.js'] });
	await computeCheck(w.ctx);
	for (const k of w.keys()) {
		assert.doesNotMatch(k, /^git (merge |worktree|stash|checkout|reset)/);
		assert.doesNotMatch(k, /^npm /);
		assert.doesNotMatch(k, /docker run|compose up|force-recreate/);
	}
});

test('run: full deploy with migrations runs the steps in order and never npm ci', async () => {
	const w = world({ changed: [MIGRATION_FILE, 'package.json', 'core/extensions/a/index.js', 'apps/starbase/x.js', 'plugins/heavy-data-worker/app.py'] });
	const r = await runDeploy(w.ctx, { id: '20261018T120000Z', actor: 'user-1' });
	assert.equal(r.ok, true, r.message);
	assert.equal(r.failedStep, null);
	assert.deepEqual(stepNames(r), ['preflight', 'worktree', 'migrate', 'merge', 'install', 'build', 'restart', 'verify', 'notes']);
	assert.ok(r.steps.every((x) => x.ok));
	assert.equal(r.id, '20261018T120000Z');
	assert.equal(r.actor, 'user-1');
	assert.equal(r.branch, 'feat/x');
	assert.equal(r.fromSha, 'aaaaaaaa');
	assert.equal(r.toSha, 'bbbbbbbb');
	assert.equal(r.backup, 'd1_20261018_1200.sql.gz');
	assert.ok(r.finishedAt);
	assert.deepEqual(r.missingEnv, ['DEPLOY_AGENT_TOKEN']);

	const keys = w.keys();
	const at = (prefix) => keys.findIndex((k) => k.startsWith(prefix));
	assert.ok(at('git worktree add -q --detach .claude/worktrees/deploy-main origin/main') > -1);
	// order: worktree, status, backup, up, merge, install, builds, compose, verify, worktree removal
	const order = [
		at('git worktree add'),
		keys.findIndex((k) => k.startsWith('docker run') && k.endsWith('dbmate:2 status')),
		keys.findIndex((k) => /bash/.test(k) && k.includes('infra/backup/backup.sh')),
		keys.findIndex((k) => k.startsWith('docker run') && k.endsWith('--no-dump-schema up')),
		at('git merge --no-edit origin/main'),
		at('npm install --no-audit --no-fund'),
		at('npm run build:extensions'),
		at('npm run build:starbase'),
		at('docker compose up -d'),
	];
	assert.ok(order.every((i) => i > -1), JSON.stringify(order));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	assert.ok(keys.includes('docker compose up -d --force-recreate directus'));
	assert.ok(keys.includes('docker compose up -d --force-recreate proxy'));
	assert.ok(keys.includes('docker compose up -d --build heavy-data-worker'));
	assert.ok(keys.findLastIndex((k) => k.startsWith('git worktree remove --force .claude/worktrees/deploy-main')) > order[4]);

	for (const k of keys) {
		assert.doesNotMatch(k, /npm ci/);
		assert.doesNotMatch(k, /git stash/);
		assert.doesNotMatch(k, /FLUSHALL/);
		assert.doesNotMatch(k, /git push/);
	}
	// the database password is passed through the environment, never on a command line
	const dbmate = w.seen('docker run').at(-1);
	assert.ok(!dbmate.args.join(' ').includes('pw@'));
	assert.equal(dbmate.opts.env.DATABASE_URL, 'postgres://d1:pw@postgres:5432/d1_database?sslmode=disable');
	assert.ok(dbmate.args.includes('d1-database_d1net'));
	assert.ok(dbmate.args.includes(`${path.join(REPO, '.claude', 'worktrees', 'deploy-main', 'db')}:/db`));
	assert.match(w.out.join(''), /##STEP preflight[\s\S]*##STEP migrate/);
});

test('run: when no migration is pending there is no backup and no up', async () => {
	const w = world({ changed: [MIGRATION_FILE], pending: 0 });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.equal(r.backup, null);
	assert.equal(w.keys().filter((k) => k.includes('backup.sh')).length, 0);
	assert.equal(w.keys().filter((k) => k.endsWith('--no-dump-schema up')).length, 0);
	assert.equal(w.keys().filter((k) => k.startsWith('git merge --no-edit')).length, 1);
});

test('run: a docs-only update merges and nothing else', async () => {
	const w = world({ changed: ['docs/x.md'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.deepEqual(stepNames(r), ['preflight', 'worktree', 'migrate', 'merge', 'install', 'build', 'restart', 'verify', 'notes']);
	assert.deepEqual(r.steps.filter((x) => x.skipped).map((x) => x.name), ['worktree', 'migrate', 'install', 'build', 'restart', 'verify']);
	assert.equal(w.keys().filter((k) => k.startsWith('npm') || k.startsWith('docker compose up')).length, 0);
});

test('run: up to date finishes ok without touching anything', async () => {
	const w = world({ upToDate: true });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true);
	assert.deepEqual(stepNames(r), ['preflight']);
	assert.match(r.message, /up to date/i);
	assert.equal(w.keys().filter((k) => k.startsWith('git merge ')).length, 0);
});

test('run: a destructive migration without the ack stops at preflight and changes nothing', async () => {
	const w = world({ changed: [MIGRATION_FILE], sql: DESTRUCTIVE_SQL });
	const r = await runDeploy(w.ctx, { ack: ['db/migrations/other.sql'] });
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, 'preflight');
	assert.match(r.message, /acknowledg/i);
	assert.match(r.message, /202610180900_add_thing/);
	assert.deepEqual(stepNames(r), ['preflight']);
	for (const k of w.keys()) {
		assert.doesNotMatch(k, /^git (merge |worktree)/);
		assert.doesNotMatch(k, /docker run|backup\.sh|npm |compose up/);
	}
});

test('run: the same migration with its ack goes through', async () => {
	const w = world({ changed: [MIGRATION_FILE], sql: DESTRUCTIVE_SQL });
	const r = await runDeploy(w.ctx, { ack: [MIGRATION_FILE] });
	assert.equal(r.ok, true, r.message);
	assert.equal(r.backup, 'd1_20261018_1200.sql.gz');
});

test('run: a blocker (overlap) stops at preflight', async () => {
	const w = world({ changed: ['docker-compose.yml'], dirty: ['docker-compose.yml'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, 'preflight');
	assert.match(r.message, /Nothing was changed/);
	assert.equal(w.keys().filter((k) => k.startsWith('git merge ')).length, 0);
});

test('run: a failed merge is aborted and names the conflicting paths, after the migration it keeps', async () => {
	const w = world({ changed: [MIGRATION_FILE, 'core/extensions/a/index.js'], mergeCode: 1, conflicted: ['core/extensions/a/index.js'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, 'merge');
	assert.match(r.message, /core\/extensions\/a\/index\.js/);
	assert.match(r.message, /d1_20261018_1200\.sql\.gz/);
	const keys = w.keys();
	const merge = keys.indexOf('git merge --no-edit origin/main');
	const abort = keys.indexOf('git merge --abort');
	assert.ok(merge > -1 && abort > merge);
	assert.equal(keys.filter((k) => k.startsWith('npm') || k.startsWith('docker compose up')).length, 0);
	// the temporary worktree is removed even on failure
	assert.ok(keys.lastIndexOf('git worktree remove --force .claude/worktrees/deploy-main') > abort);
});

test('run: a failed backup applies no migration', async () => {
	const w = world({ changed: [MIGRATION_FILE], backupCode: 1 });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, 'migrate');
	assert.match(r.message, /no migration was applied/i);
	assert.equal(w.keys().filter((k) => k.endsWith('--no-dump-schema up')).length, 0);
	assert.equal(w.keys().filter((k) => k.startsWith('git merge --no-edit')).length, 0);
});

test('run: DATABASE_URL missing in .env fails the migrate step', async () => {
	const w = world({ changed: [MIGRATION_FILE], envText: 'POSTGRES_PASSWORD=x\n' });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'migrate');
	assert.match(r.message, /DATABASE_URL/);
});

test('run: a failed migration names the backup', async () => {
	const w = world({ changed: [MIGRATION_FILE], upCode: 1 });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'migrate');
	assert.match(r.message, /d1_20261018_1200\.sql\.gz/);
});

test('run: a failed build stops before the restart and says which build', async () => {
	const w = world({ changed: ['core/extensions/a/index.js'], buildCode: 1 });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'build');
	assert.match(r.message, /build:extensions/);
	assert.equal(w.keys().filter((k) => k.startsWith('docker compose up')).length, 0);
});

test('run: install failure is recorded; npm ci is never used', async () => {
	const w = world({ changed: ['package.json'], installCode: 1 });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'install');
	assert.equal(w.keys().filter((k) => /npm ci/.test(k)).length, 0);
});

test('run: verify waits for health, then passes', async () => {
	const w = world({
		changed: ['core/extensions/a/index.js'],
		psRows: (n) => [{ Service: 'directus', State: 'running', Health: n < 3 ? 'starting' : 'healthy' }],
	});
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(w.seen('docker compose --profile * ps -a').length >= 3);
});

test('run: verify gives up after 180 s and lists the unhealthy service', async () => {
	const w = world({
		changed: ['core/extensions/a/index.js'],
		psRows: () => [{ Service: 'directus', State: 'running', Health: 'unhealthy' }],
	});
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, 'verify');
	assert.match(r.message, /directus: running \(unhealthy\)/);
});

test('run: a profile-gated build service that is not running is rebuilt but not started', async () => {
	const w = world({ changed: ['plugins/surface-scan-worker/a.py'], psRows: [] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	const keys = w.keys();
	assert.ok(keys.includes('docker compose --profile archive build surface-scan-worker'));
	assert.ok(!keys.some((k) => k.includes('up -d --build surface-scan-worker')));
});

test('run: inbox-crawler is recreated only when it is already running', async () => {
	let w = world({
		changed: ['scripts/inbox_crawler/x.py'],
		psRows: [{ Service: 'inbox-crawler', State: 'running', Health: '' }],
	});
	let r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(w.keys().includes('docker compose --profile archive up -d --force-recreate inbox-crawler'));

	w = world({ changed: ['scripts/inbox_crawler/x.py'], psRows: [] });
	r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(!w.keys().some((k) => k.includes('force-recreate inbox-crawler')));
});

test('run: compose change brings the stack up and judges every service', async () => {
	const w = world({
		changed: ['docker-compose.yml'],
		psRows: [
			{ Service: 'directus', State: 'running', Health: 'healthy' },
			{ Service: 'init', State: 'exited', ExitCode: 0 },
		],
	});
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(w.keys().includes('docker compose up -d'));
	assert.equal(w.keys().filter((k) => k.includes('force-recreate')).length, 0);
});

test('run: npm is called with fixed args only, and paths with spaces stay single args', async () => {
	const w = world({ changed: ['package.json', 'apps/starbase/x.js'] });
	await runDeploy(w.ctx, {});
	for (const c of w.seen('npm')) assert.ok(c.args.every((a) => /^[a-z:-]+$/.test(a)), c.args.join(' '));
});

test('main: check --json prints one JSON document; run --json writes the result file', async () => {
	const w = world({ changed: ['docs/x.md'] });
	let out = '';
	let code = await main(['check', '--json'], { ...w.ctx, repoDir: REPO, stdout: (s) => (out += s), stderr: () => {} });
	assert.equal(code, 0);
	assert.equal(JSON.parse(out).upToDate, false);

	const w2 = world({ changed: ['docs/x.md'] });
	out = '';
	const resultFile = path.join(REPO, 'logs', 'deploy', '20261018T120000Z', 'result.json');
	code = await main(['run', '--json', '--id', '20261018T120000Z', '--actor', 'u', '--result-file', resultFile, '--ack', 'a', 'b'], {
		exec: w2.ctx.exec,
		repoDir: REPO,
		env: {},
		fsx: w2.ctx.fsx,
		now: w2.ctx.now,
		sleep: w2.ctx.sleep,
		stdout: (s) => (out += s),
		stderr: () => {},
	});
	assert.equal(code, 0);
	assert.match(out, /^##RESULT \{.*"ok":true/m);
	assert.equal(JSON.parse(w2.written.get(resultFile)).id, '20261018T120000Z');
});

test('main: a failed run exits 1; a bad command exits 2', async () => {
	const w = world({ changed: ['docker-compose.yml'], dirty: ['docker-compose.yml'] });
	const base = { exec: w.ctx.exec, repoDir: REPO, env: {}, fsx: w.ctx.fsx, now: w.ctx.now, sleep: w.ctx.sleep, stdout: () => {}, stderr: () => {} };
	assert.equal(await main(['run'], base), 1);
	assert.equal(await main(['frobnicate'], base), 2);
	assert.equal(await main(['run', '--nope'], base), 2);
});

test('parseArgs reads repeated and multi-value --ack', () => {
	assert.deepEqual(parseArgs(['run', '--ack', 'a', 'b', '--json', '--ack=c']).ack, ['a', 'b', 'c']);
	assert.equal(parseArgs(['run', '--json']).json, true);
	assert.deepEqual(parseArgs(['check']).ack, []);
});

test('run: package-lock.json that npm install rewrote is restored; one that was already dirty is kept', async () => {
	const a = world({ changed: ['package.json'], lockDirtyAfterInstall: true });
	await runDeploy(a.ctx, {});
	assert.ok(a.keys().includes('git checkout -- package-lock.json'));
	const b = world({ changed: ['package.json'], lockDirtyAfterInstall: true, dirty: ['package-lock.json'] });
	await runDeploy(b.ctx, {});
	assert.ok(!b.keys().includes('git checkout -- package-lock.json'));
});
