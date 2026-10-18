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

const HEAD_SHA = 'a'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);
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
	let headCalls = 0;
	let branchCalls = 0;
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
		if (k === 'git rev-parse --abbrev-ref HEAD') {
			branchCalls++;
			return ok(`${s.branchSeq ? s.branchSeq(branchCalls) : (s.branch ?? 'feat/x')}\n`);
		}
		if (k === 'git rev-parse HEAD') {
			headCalls++;
			return ok(`${s.headSeq ? s.headSeq(headCalls) : HEAD_SHA}\n`);
		}
		if (k === 'git rev-parse --short=8 HEAD') return ok(calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--no-edit') && !s.mergeCode ? 'bbbbbbbb\n' : 'aaaaaaaa\n');
		if (k === 'git rev-parse origin/main') return ok(`${TARGET_SHA}\n`);
		if (k.startsWith('git log --format=')) return ok(s.upToDate ? '' : `${'1'.repeat(40)}\tfeat: one\n${'2'.repeat(40)}\tfix: two\n`);
		if (k.startsWith('git status --porcelain -z --untracked-files=no -- package-lock.json')) return ok(s.lockDirtyAfterInstall ? ` M package-lock.json${NUL}` : '');
		if (k.startsWith('git status --porcelain')) return ok((s.dirty ?? []).map((f) => ` M ${f}${NUL}`).join(''));
		if (k.startsWith('git diff --name-only -z --no-renames --diff-filter=AM')) return ok(changed.filter((f) => f.startsWith('db/migrations/')).map((f) => f + NUL).join(''));
		if (k.startsWith('git diff --name-only -z --no-renames --diff-filter=A ')) return ok((s.added ?? changed).map((f) => f + NUL).join(''));
		if (k === `git diff --name-only -z --no-renames HEAD...${TARGET_SHA}`) return ok(changed.map((f) => f + NUL).join(''));
		if (k.startsWith('git diff --name-only -z --no-renames --diff-filter=U')) return ok(s.conflicted ? s.conflicted.map((f) => f + NUL).join('') : '');
		if (k.startsWith('git ls-files --others --exclude-standard -z')) return ok((s.untracked ?? []).map((f) => f + NUL).join(''));
		if (k.startsWith(`git show ${TARGET_SHA}:`)) return ok(s.sql ?? SAFE_SQL);
		if (k.startsWith('git merge-tree')) return s.mergeTree ?? { code: 0, stdout: `treeoid${NUL}`, stderr: '' };
		if (k === 'git merge --abort') return s.abortCode ? { code: s.abortCode, stdout: '', stderr: 'no merge to abort' } : ok();
		if (k.startsWith('git merge --no-edit ')) return s.mergeCode ? { code: s.mergeCode, stdout: 'CONFLICT', stderr: '' } : ok('Merge made');
		if (cmd === 'docker' && args.join(' ').startsWith('compose --profile * config')) return s.composeConfigFail ? { code: 1, stdout: '', stderr: 'bad interpolation' } : ok(COMPOSE_CONFIG);
		if (cmd === 'docker' && args[0] === 'run') {
			const tail = args.slice(args.indexOf('ghcr.io/amacneil/dbmate:2') + 1).join(' ');
			if (tail === 'status') {
				const n = s.pending ?? 1;
				const names = s.pendingFiles ?? [MIGRATION_FILE.split('/').pop()].slice(0, n);
				return ok(`[X] a.sql\n${names.map((f) => `[ ] ${f}`).join('\n')}\n\nApplied: 1\nPending: ${n}\n`);
			}
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
		'git rev-parse HEAD',
		'git rev-parse origin/main',
		`git log --format=%H%x09%s HEAD..${TARGET_SHA}`,
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
	let w = world({ mergeTree: { code: 1, stdout: `oid${NUL}core/extensions/foo/index.js${NUL}${NUL}CONFLICT (content)${NUL}`, stderr: '' } });
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
	// the worktree and the merge use the sha resolved at preflight, never the symbolic ref
	assert.ok(at(`git worktree add -q --detach .claude/worktrees/deploy-main ${TARGET_SHA}`) > -1);
	// order: worktree, status, backup, up, merge, install, builds, compose, verify, worktree removal
	const order = [
		at('git worktree add'),
		keys.findIndex((k) => k.startsWith('docker run') && k.endsWith('dbmate:2 status')),
		keys.findIndex((k) => /bash/.test(k) && k.includes('infra/backup/backup.sh')),
		keys.findIndex((k) => k.startsWith('docker run') && k.endsWith('--no-dump-schema up')),
		at('git merge --no-edit'),
		at('npm install --no-audit --no-fund'),
		at('npm run build:extensions'),
		at('npm run build:starbase'),
		at('docker compose up -d'),
	];
	assert.ok(order.every((i) => i > -1), JSON.stringify(order));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	assert.ok(keys.includes('docker compose up -d --no-deps --force-recreate directus'));
	assert.ok(keys.includes('docker compose up -d --no-deps --force-recreate proxy'));
	assert.ok(keys.includes('docker compose up -d --no-deps --build heavy-data-worker'));
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
	const merge = keys.findIndex((k) => k.startsWith('git merge --no-edit'));
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
	assert.ok(!keys.some((k) => k.includes('up -d --no-deps --build surface-scan-worker')));
});

test('run: inbox-crawler is recreated only when it is already running', async () => {
	let w = world({
		changed: ['scripts/inbox_crawler/x.py'],
		psRows: [{ Service: 'inbox-crawler', State: 'running', Health: '' }],
	});
	let r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(w.keys().includes('docker compose --profile archive up -d --no-deps --force-recreate inbox-crawler'));

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
		lockfs: memLockFs(),
		stderr: () => {},
	});
	assert.equal(code, 0);
	assert.match(out, /^##RESULT \{.*"ok":true/m);
	assert.equal(JSON.parse(w2.written.get(resultFile)).id, '20261018T120000Z');
});

test('main: a failed run exits 1; a bad command exits 2', async () => {
	const w = world({ changed: ['docker-compose.yml'], dirty: ['docker-compose.yml'] });
	const base = { exec: w.ctx.exec, repoDir: REPO, env: {}, lockfs: memLockFs(), fsx: w.ctx.fsx, now: w.ctx.now, sleep: w.ctx.sleep, stdout: () => {}, stderr: () => {} };
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

// ---- pinned target, untracked collisions, migration whitelist, merge abort ---------------------

test('run: the worktree and the merge use the sha resolved at preflight, not origin/main', async () => {
	const w = world({ changed: [MIGRATION_FILE, 'docs/x.md'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	const merge = w.seen('git merge --no-edit')[0];
	assert.equal(merge.args.at(-1), TARGET_SHA);
	assert.ok(!merge.args.includes('origin/main'));
	const add = w.seen('git worktree add')[0];
	assert.equal(add.args.at(-1), TARGET_SHA);
	// every ref-taking read after the fetch is pinned too (only the one rev-parse resolves the symbolic name)
	const resolvers = w.keys().filter((k) => /(^| )origin\/main($| )/.test(k) && !k.includes('-m '));
	assert.deepEqual(resolvers, ['git rev-parse origin/main']);
});

test('check: the result carries the full shas it pinned', async () => {
	const c = await computeCheck(world({}).ctx);
	assert.equal(c.headSha, HEAD_SHA);
	assert.equal(c.targetSha, TARGET_SHA);
});

test('run: refuses to merge when HEAD moved after the preflight', async () => {
	const w = world({ changed: ['docs/x.md'], headSeq: (n) => (n === 1 ? HEAD_SHA : 'c'.repeat(40)) });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, 'merge');
	assert.match(r.message, /moved since the preflight/);
	assert.equal(w.seen('git merge --no-edit').length, 0);
});

test('run: refuses to merge when the branch changed after the preflight', async () => {
	const w = world({ changed: ['docs/x.md'], branchSeq: (n) => (n === 1 ? 'feat/x' : 'main') });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'merge');
	assert.match(r.message, /changed branch.*feat\/x -> main/);
	assert.equal(w.seen('git merge --no-edit').length, 0);
});

test('run: a moved HEAD is caught before the migration too (no backup, nothing applied)', async () => {
	const w = world({ changed: [MIGRATION_FILE], headSeq: (n) => (n === 1 ? HEAD_SHA : 'c'.repeat(40)) });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'migrate');
	assert.equal(w.keys().filter((k) => k.includes('backup.sh') || k.endsWith('--no-dump-schema up')).length, 0);
});

test('every diff call uses --no-renames, and name lists use -z', async () => {
	const w = world({ changed: [MIGRATION_FILE, 'core/extensions/a/index.js'], mergeCode: 1, conflicted: ['x'] });
	await runDeploy(w.ctx, {});
	const diffs = w.seen('git diff');
	assert.ok(diffs.length >= 4);
	for (const d of diffs) {
		assert.ok(d.args.includes('--no-renames'), d.args.join(' '));
		assert.ok(d.args.includes('-z'), d.args.join(' '));
	}
	assert.ok(w.seen('git merge-tree')[0].args.includes('-z'));
});

test('check: an untracked file that the update adds is a blocker (untracked_overlap)', async () => {
	const w = world({ changed: ['apps/new.txt', 'README.md'], added: ['apps/new.txt'], untracked: ['apps/new.txt', 'scratch.txt'] });
	const c = await computeCheck(w.ctx);
	assert.deepEqual(c.untrackedOverlap, ['apps/new.txt']);
	assert.equal(c.blockers.length, 1);
	assert.equal(c.blockers[0].code, 'untracked_overlap');
	assert.match(c.blockers[0].message, /apps\/new\.txt/);
	// untracked files the update does not add are no problem
	const ok = await computeCheck(world({ changed: ['README.md'], added: [], untracked: ['scratch.txt'] }).ctx);
	assert.deepEqual(ok.blockers, []);
});

test('run: an untracked collision stops at preflight and changes nothing', async () => {
	const w = world({ changed: ['apps/new.txt'], added: ['apps/new.txt'], untracked: ['apps/new.txt'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'preflight');
	assert.equal(w.seen('git merge --no-edit').length, 0);
	assert.equal(w.seen('git worktree add').length, 0);
});

test('run: a failed merge abort is reported, not claimed clean', async () => {
	const w = world({ changed: ['core/extensions/a/index.js'], mergeCode: 1, conflicted: ['core/extensions/a/index.js'], abortCode: 128 });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'merge');
	assert.match(r.message, /merge abort FAILED/);
	assert.match(r.message, /mid-merge/);
	assert.doesNotMatch(r.message, /working tree is as before/);
});

test('run: a pending migration that is not part of this update is refused before any backup', async () => {
	const w = world({ changed: [MIGRATION_FILE], pending: 2, pendingFiles: ['202610170000_old_leftover.sql', '202610180900_add_thing.sql'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, false);
	assert.equal(r.failedStep, 'migrate');
	assert.match(r.message, /202610170000_old_leftover\.sql is pending but not part of this update; deploy it with \/starbase-deploy/);
	assert.doesNotMatch(r.message, /202610180900_add_thing/);
	assert.equal(w.keys().filter((k) => k.includes('backup.sh') || k.endsWith('--no-dump-schema up')).length, 0);
	assert.equal(w.seen('git merge --no-edit').length, 0);
	assert.equal(r.backup, null);
});

test('run: an unreadable dbmate status with pending migrations is refused', async () => {
	const w = world({ changed: [MIGRATION_FILE], pending: 1, pendingFiles: [] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'migrate');
	assert.match(r.message, /could not be read/);
	assert.equal(w.keys().filter((k) => k.includes('backup.sh')).length, 0);
});

test('run: a renamed migration counts as added and is applied', async () => {
	// with --no-renames git reports the new name as an addition
	const renamed = 'db/migrations/202610180901_renamed.sql';
	const w = world({ changed: ['db/migrations/202610180900_old_name.sql', renamed], pendingFiles: ['202610180901_renamed.sql'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.equal(w.keys().filter((k) => k.endsWith('--no-dump-schema up')).length, 1);
});

test('run: no plain `up -d` unless docker-compose.yml changed', async () => {
	const w = world({ changed: ['core/extensions/a/index.js'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(!w.keys().includes('docker compose up -d'));
	assert.ok(w.keys().includes('docker compose up -d --no-deps --force-recreate directus'));
});

// ---- timeouts and no prompts -------------------------------------------------------------------

test('every command has a time limit, and git never prompts', async () => {
	const w = world({
		changed: [MIGRATION_FILE, 'package.json', 'core/extensions/a/index.js', 'apps/starbase/x.js', 'plugins/heavy-data-worker/app.py'],
		processEnv: { PATH: '/bin' },
	});
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(w.calls.length > 20);
	for (const c of w.calls) {
		assert.ok(Number.isInteger(c.opts.timeoutMs) && c.opts.timeoutMs > 0, `no timeout: ${c.cmd} ${c.args.join(' ')}`);
		if (c.cmd === 'git') {
			assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0', c.args.join(' '));
			assert.equal(c.opts.env.GCM_INTERACTIVE, 'never', c.args.join(' '));
			assert.equal(c.opts.env.PATH, '/bin');
		}
	}
	const limit = (prefix) => w.seen(prefix)[0].opts.timeoutMs;
	assert.equal(limit('git fetch'), 120_000);
	assert.equal(limit('git rev-parse'), 30_000);
	assert.equal(limit('docker compose up'), 300_000);
	assert.equal(limit('docker compose --profile * ps'), 300_000);
	assert.equal(limit('npm install'), 900_000);
	assert.equal(limit('npm run'), 900_000);
	assert.equal(limit('docker run'), 600_000);
	assert.equal(w.calls.find((c) => /bash/.test(c.cmd)).opts.timeoutMs, 900_000);
});

test('a command that times out fails its step with "timed out"', async () => {
	const w = world({ changed: ['core/extensions/a/index.js'] });
	const inner = w.ctx.exec;
	w.ctx.exec = async (cmd, args, opts) => (cmd === 'npm' ? { code: -2, stdout: '', stderr: 'timed out after 900000 ms' } : inner(cmd, args, opts));
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.failedStep, 'build');
	assert.match(r.message, /npm run build:extensions failed \(timed out\)/);

	const w2 = world({});
	const inner2 = w2.ctx.exec;
	w2.ctx.exec = async (cmd, args, opts) => (args[0] === 'fetch' ? { code: -2, stdout: '', stderr: 'timed out' } : inner2(cmd, args, opts));
	const r2 = await runDeploy(w2.ctx, {});
	assert.equal(r2.failedStep, 'preflight');
	assert.match(r2.message, /git fetch failed: timed out/);
});

// ---- the run lock for a run started by hand ----------------------------------------------------

/** An in-memory lock file with the makeLockFs interface. */
function memLockFs(initial = null, mtimeMs = Date.now()) {
	let cur = initial ? { text: JSON.stringify(initial), mtimeMs } : null;
	return {
		get current() {
			return cur;
		},
		createExclusive(text) {
			if (cur) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
			cur = { text, mtimeMs: Date.now() };
		},
		read() {
			if (!cur) return null;
			let lock = null;
			try {
				lock = JSON.parse(cur.text);
			} catch {
				/* damaged */
			}
			return { lock, mtimeMs: cur.mtimeMs };
		},
		write(text) {
			cur = { text, mtimeMs: Date.now() };
		},
		remove() {
			cur = null;
		},
		touch() {
			if (cur) cur.mtimeMs = Date.now();
		},
	};
}

function runDeps(w, extra = {}) {
	const out = [];
	const err = [];
	return {
		out,
		err,
		deps: { exec: w.ctx.exec, repoDir: REPO, env: {}, fsx: w.ctx.fsx, now: () => Date.now(), sleep: w.ctx.sleep, stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...extra },
	};
}

test('a hand-run takes the lock, holds it for the run and releases it after', async () => {
	const w = world({ changed: ['docs/x.md'] });
	const lockfs = memLockFs();
	let during = null;
	const inner = w.ctx.exec;
	w.ctx.exec = async (cmd, args, opts) => {
		if (args[0] === 'merge' && args[1] === '--no-edit') during = lockfs.read();
		return inner(cmd, args, opts);
	};
	const { deps } = runDeps(w, { lockfs, pid: 4242 });
	const code = await main(['run', '--id', '20261018T130000Z', '--actor', 'me'], deps);
	assert.equal(code, 0);
	assert.equal(during.lock.id, '20261018T130000Z');
	assert.equal(during.lock.pid, 4242);
	assert.equal(during.lock.actor, 'me');
	assert.equal(lockfs.current, null);
});

test('a hand-run refuses while another run is live, and touches nothing', async () => {
	const w = world({ changed: ['docs/x.md'] });
	const holder = { id: '20261018T120000Z', pid: 7777, startedAt: '2026-10-18T12:00:00.000Z', actor: 'button' };
	const lockfs = memLockFs(holder);
	const { deps, err } = runDeps(w, { lockfs, isAlive: (pid) => pid === 7777 });
	const code = await main(['run'], deps);
	assert.equal(code, 3);
	assert.match(err.join(''), /Another deploy is running \(run 20261018T120000Z, pid 7777/);
	assert.equal(w.calls.length, 0);
	assert.deepEqual(JSON.parse(lockfs.current.text), holder);
});

test('a hand-run takes over a stale lock: dead process, or not refreshed (pid reuse)', async () => {
	const holder = { id: '20261018T110000Z', pid: 7777, startedAt: 'x', actor: null };
	// process gone
	let w = world({ changed: ['docs/x.md'] });
	let lockfs = memLockFs(holder);
	assert.equal(await main(['run'], runDeps(w, { lockfs, isAlive: () => false }).deps), 0);
	// the pid exists (reused by something else) but the lock was last refreshed an hour ago
	w = world({ changed: ['docs/x.md'] });
	lockfs = memLockFs(holder, Date.now() - 60 * 60_000);
	assert.equal(await main(['run'], runDeps(w, { lockfs, isAlive: () => true }).deps), 0);
});

test('--lock-held: the agent owns the lock, the run neither takes nor releases it, and keeps it fresh', async () => {
	const w = world({ changed: ['docs/x.md'] });
	const mine = { id: '20261018T140000Z', pid: process.pid, startedAt: 'x', actor: 'u' };
	const lockfs = memLockFs(mine, Date.now() - 10 * 60_000);
	const { deps } = runDeps(w, { lockfs, heartbeatMs: 5 });
	const inner = w.ctx.exec;
	deps.exec = async (cmd, args, opts) => {
		await new Promise((r) => setTimeout(r, 40)); // give the heartbeat time to fire
		return inner(cmd, args, opts);
	};
	const code = await main(['run', '--lock-held', '--id', '20261018T140000Z'], deps);
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(lockfs.current.text), mine, 'lock left in place for its owner');
	assert.ok(Date.now() - lockfs.current.mtimeMs < 60_000, 'heartbeat refreshed the lock');
});

test('parseArgs knows --lock-held', () => {
	assert.equal(parseArgs(['run', '--lock-held']).lockHeld, true);
	assert.equal(parseArgs(['run']).lockHeld, false);
});

// ---- restart mapping gaps (caddy, tailscale device) and --no-deps ------------------------------

test('run: a Caddyfile change recreates the proxy; the dependencies are never recreated (--no-deps)', async () => {
	const w = world({ changed: ['infra/caddy/Caddyfile'] });
	const r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(w.keys().includes('docker compose up -d --no-deps --force-recreate proxy'));
	for (const c of w.calls) {
		if (c.args.includes('--force-recreate')) assert.ok(c.args.includes('--no-deps'), c.args.join(' '));
	}
});

test('run: the starbase tailnet device is recreated only when it is already running', async () => {
	let w = world({ changed: ['infra/tailscale/starbase-serve.json'], psRows: [{ Service: 'starbase', State: 'running', Health: '' }] });
	let r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(w.keys().includes('docker compose --profile starbase up -d --no-deps --force-recreate starbase'));

	w = world({ changed: ['infra/tailscale/starbase-serve.json'], psRows: [] });
	r = await runDeploy(w.ctx, {});
	assert.equal(r.ok, true, r.message);
	assert.ok(!w.keys().some((k) => k.includes('force-recreate starbase')));
	assert.match(w.out.join(''), /starbase is not running; left stopped/);
});
