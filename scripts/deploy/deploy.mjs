#!/usr/bin/env node
// Deploy origin/main to the live stack on d1-server: the safe subset of /starbase-deploy (see
// docs/superpowers/specs/2026-10-18-deploy-button-design.md and docs/runbooks/deploy-button.md).
//
//   node scripts/deploy/deploy.mjs check [--json]
//   node scripts/deploy/deploy.mjs run [--json] [--ack <file> ...] [--id <run id>] [--actor <who>] [--result-file <path>] [--lock-held]
//
// `check` changes nothing (it only fetches). `run` stops, without touching anything beyond a backup, whenever a
// judgement call is needed. Never: git stash, redis-cli FLUSHALL, npm ci, git push, other sessions' containers.
// The process runner is injected (`exec`) so the tests never call real git, docker or npm.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildServicesFromConfig,
	acquireRunLock,
	encodePs,
	formatRunId,
	HOLDERS_PS,
	isPidAlive,
	makeExec,
	makeLockFs,
	missingEnvKeys,
	OPTIONAL_SERVICES,
	overlap,
	parseBackupName,
	parseComposePs,
	parseEnv,
	parseHolders,
	parseMergeTree,
	parsePending,
	parsePendingDeploy,
	parsePendingFiles,
	parsePorcelainZ,
	PENDING_FILE,
	planSteps,
	releaseRunLock,
	rewriteDbUrl,
	runningServices,
	scanDestructive,
	serviceProblems,
	splitNul,
	startHeartbeat,
	STOP_HOLDERS_ACK,
} from './lib.mjs';

const DBMATE_IMAGE = 'ghcr.io/amacneil/dbmate:2';
const WORKTREE_REL = '.claude/worktrees/deploy-main';
const VERIFY_TIMEOUT_MS = 180_000;
const VERIFY_POLL_MS = 3_000;
/** Per-command time limits (ms). A command that hangs is killed (whole process tree) and the step fails with "timed out". */
export const T = {
	fetch: 120_000,
	git: 30_000,
	checkout: 300_000, // git worktree add / git merge write the whole tree
	compose: 300_000,
	install: 900_000,
	build: 900_000,
	dbmate: 600_000,
	backup: 900_000,
};

class StepError extends Error {}

const iso = (ms) => new Date(ms).toISOString();

/** The real filesystem access; tests pass a fake. */
export function makeFsx() {
	return {
		readText(p) {
			try {
				return readFileSync(p, 'utf8');
			} catch {
				return null;
			}
		},
		writeText(p, text) {
			mkdirSync(path.dirname(p), { recursive: true });
			const tmp = `${p}.tmp`;
			writeFileSync(tmp, text);
			renameSync(tmp, p);
		},
		remove(p) {
			try {
				unlinkSync(p);
			} catch {
				/* already gone */
			}
		},
	};
}

/** Processes using the live node_modules (a dev server's esbuild, a native module). Windows only; [] elsewhere or on any failure. */
async function findHolders(ctx) {
	if ((ctx.platform ?? process.platform) !== 'win32') return [];
	const r = await ctx.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(HOLDERS_PS)], {
		cwd: ctx.repoDir,
		env: { ...ctx.env, DEPLOY_NM_ROOT: path.join(ctx.repoDir, 'node_modules'), DEPLOY_SELF_PID: String(ctx.pid ?? process.pid) },
		timeoutMs: T.git,
	});
	return r.code === 0 ? parseHolders(r.stdout) : [];
}

/** Stop what holds node_modules right now (whole process tree), never this process or its ancestors. Returns what was stopped. */
async function stopHolders(ctx) {
	const holders = await findHolders(ctx);
	const self = ctx.pid ?? process.pid;
	for (const h of holders) {
		if (h.pid === self) continue;
		await ctx.exec('taskkill', ['/PID', String(h.pid), '/T', '/F'], { cwd: ctx.repoDir, timeoutMs: T.git });
	}
	if (holders.length) await ctx.sleep(1500); // let Windows release the file handles
	return holders;
}

/** The unfinished deploy recorded after a merge whose later steps failed, if its base is still in HEAD's history. */
async function readUnfinished(ctx) {
	const pending = parsePendingDeploy(ctx.fsx.readText(path.join(ctx.repoDir, PENDING_FILE)));
	if (!pending) return null;
	const anc = await git(ctx, ['merge-base', '--is-ancestor', pending.fromSha, 'HEAD']);
	return anc.code === 0 ? pending : null; // an unknown or rewritten base means the record is stale
}

/** git never prompts for credentials (a prompt would hang a run nobody is watching). */
function git(ctx, args, o = {}) {
	return ctx.exec('git', args, {
		cwd: ctx.repoDir,
		timeoutMs: T.git,
		...o,
		env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
	});
}

function compose(ctx, args, o = {}) {
	return ctx.exec('docker', ['compose', ...args], { cwd: ctx.repoDir, onData: ctx.onData, timeoutMs: T.compose, ...o });
}

/** "exit 3" or "timed out" (the runner reports a killed command as code -2). */
const why = (r) => (r.code === -2 ? 'timed out' : `exit ${r.code}`);

function must(r, what) {
	if (r.code !== 0) throw new Error(`${what} failed: ${r.code === -2 ? 'timed out' : (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-3).join(' | ')}`);
	return r.stdout;
}

/** Build services from `docker compose config`; `error` is set when compose could not be read. */
async function readBuildServices(ctx) {
	const r = await compose(ctx, ['--profile', '*', 'config', '--format', 'json'], { onData: undefined });
	if (r.code !== 0) return { services: [], error: (r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' | ') };
	try {
		return { services: buildServicesFromConfig(JSON.parse(r.stdout), ctx.repoDir), error: null };
	} catch (e) {
		return { services: [], error: `docker compose config printed invalid JSON (${e.message})` };
	}
}

/** `check`: what would a deploy do, and does anything stand in its way. Only runs `git fetch`. */
export async function computeCheck(ctx) {
	must(await git(ctx, ['fetch', '-q', 'origin'], { timeoutMs: T.fetch }), 'git fetch');
	const branch = must(await git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']), 'git rev-parse HEAD').trim();
	const headSha = must(await git(ctx, ['rev-parse', 'HEAD']), 'git rev-parse HEAD').trim();
	// The target is resolved ONCE. Everything after this (diffs, scans, the worktree, the merge) uses this sha, so a
	// push to main in the middle of a run cannot make the deploy act on something other than what was checked.
	const targetSha = must(await git(ctx, ['rev-parse', 'origin/main']), 'git rev-parse origin/main').trim();
	const head = headSha.slice(0, 8);
	const target = targetSha.slice(0, 8);
	const logOut = must(await git(ctx, ['log', '--format=%H%x09%s', `HEAD..${targetSha}`]), 'git log');
	const commits = logOut
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			const [sha, ...rest] = l.split('\t');
			return { sha: sha.slice(0, 8), subject: rest.join('\t') };
		});
	const dirty = parsePorcelainZ(must(await git(ctx, ['status', '--porcelain', '-z', '--untracked-files=no']), 'git status'));

	const result = {
		upToDate: commits.length === 0,
		branch,
		head,
		target,
		headSha,
		targetSha,
		commits,
		changedCount: 0,
		steps: [],
		migrations: [],
		dirty,
		overlap: [],
		untrackedOverlap: [],
		conflicts: [],
		blockers: [],
		needsAck: [],
		holders: [],
		resume: null,
	};

	// A merge that landed but whose install/build/restart did not finish: HEAD already equals origin/main, so the
	// plain comparison says "up to date". Offer to finish what was missed instead.
	const unfinished = await readUnfinished(ctx);
	if (unfinished) return resumeCheck(ctx, result, unfinished);
	if (result.upToDate) return result;

	// --no-renames: a renamed file is a delete plus an add, so a renamed migration counts as added and overlap sees both paths.
	const range = `HEAD...${targetSha}`;
	const changed = splitNul(must(await git(ctx, ['diff', '--name-only', '-z', '--no-renames', range]), 'git diff'));
	result.changedCount = changed.length;
	const added = splitNul(must(await git(ctx, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', range]), 'git diff added'));
	const migrationFiles = splitNul(
		must(await git(ctx, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=AM', range, '--', 'db/migrations']), 'git diff migrations'),
	).filter((f) => f.endsWith('.sql'));
	for (const file of migrationFiles) {
		const show = await git(ctx, ['show', `${targetSha}:${file}`]);
		const destructive = show.code === 0 ? scanDestructive(show.stdout) : ['unreadable'];
		result.migrations.push({ file, destructive });
		if (destructive.length) result.needsAck.push(file);
	}

	const { services, error } = await readBuildServices(ctx);
	result.steps = planSteps(changed, services);
	await addHolders(ctx, result);
	result.overlap = overlap(dirty, changed);
	// A new file in the update that already exists untracked here: git refuses the merge ("would be overwritten").
	const untracked = splitNul(must(await git(ctx, ['ls-files', '--others', '--exclude-standard', '-z']), 'git ls-files'));
	result.untrackedOverlap = overlap(untracked, added);

	const mt = await git(ctx, ['merge-tree', '--write-tree', '--name-only', '-z', 'HEAD', targetSha]);
	result.conflicts = parseMergeTree(mt);

	if (result.overlap.length) {
		result.blockers.push({
			code: 'overlap',
			message: `Uncommitted edits in files this update also changes: ${result.overlap.join(', ')}. Resolve them with /starbase-deploy.`,
		});
	}
	if (result.untrackedOverlap.length) {
		result.blockers.push({
			code: 'untracked_overlap',
			message: `Untracked files here would be overwritten by files the update adds: ${result.untrackedOverlap.join(', ')}. Move or remove them, or use /starbase-deploy.`,
		});
	}
	if (result.conflicts?.length) {
		result.blockers.push({
			code: 'conflict',
			message: `Merging origin/main would conflict in: ${result.conflicts.join(', ')}. Resolve them with /starbase-deploy.`,
		});
	}
	if (error) {
		result.blockers.push({ code: 'compose_config', message: `docker compose config failed, so the services to rebuild cannot be worked out: ${error}` });
	}
	return result;
}

/** When npm install is planned, list the processes that would make it fail with EBUSY; stopping them needs a tick. */
async function addHolders(ctx, result) {
	if (!result.steps.includes('install')) return;
	result.holders = await findHolders(ctx);
	if (result.holders.length) result.needsAck.push(STOP_HOLDERS_ACK);
}

/** `check` for an unfinished deploy: the merge is in HEAD, so the steps come from the diff since the merge's base. */
async function resumeCheck(ctx, result, pending) {
	const changed = splitNul(must(await git(ctx, ['diff', '--name-only', '-z', '--no-renames', pending.fromSha, 'HEAD']), 'git diff'));
	const logOut = must(await git(ctx, ['log', '--format=%H%x09%s', `${pending.fromSha}..HEAD`]), 'git log');
	const { services, error } = await readBuildServices(ctx);
	Object.assign(result, {
		upToDate: false,
		resume: pending,
		target: result.head,
		targetSha: result.headSha,
		commits: logOut
			.split('\n')
			.filter(Boolean)
			.map((l) => {
				const [sha, ...rest] = l.split('\t');
				return { sha: sha.slice(0, 8), subject: rest.join('\t') };
			}),
		changedCount: changed.length,
		// The migrations ran before the merge; they are not run again.
		steps: planSteps(changed, services).filter((s) => s !== 'migrate'),
	});
	await addHolders(ctx, result);
	if (error) {
		result.blockers.push({ code: 'compose_config', message: `docker compose config failed, so the services to rebuild cannot be worked out: ${error}` });
	}
	return result;
}

function summarise(check) {
	const lines = [];
	if (check.resume) {
		const r = check.resume;
		lines.push(`An earlier deploy (run ${r.runId ?? 'unknown'}) merged ${r.fromSha.slice(0, 8)} -> ${check.target} but stopped at ${r.failedStep ?? 'a later step'}${r.message ? `: ${r.message}` : ''}`);
		lines.push(`Resuming it: ${check.commits.length} commit(s), ${check.changedCount} file(s) changed since then.`);
		lines.push(`Steps: ${check.steps.length ? check.steps.join(', ') : 'none'}`);
		for (const h of check.holders) lines.push(`Holding node_modules: ${h.name} (pid ${h.pid}) ${h.reason}`);
		for (const b of check.blockers) lines.push(`BLOCKED (${b.code}): ${b.message}`);
		if (check.needsAck.length) lines.push(`Needs acknowledgement: ${check.needsAck.join(', ')}`);
		return lines.join('\n');
	}
	if (check.upToDate) return `Up to date with origin/main (${check.head}) on ${check.branch}.`;
	lines.push(`${check.commits.length} new commit(s) on origin/main (${check.head} -> ${check.target}), ${check.changedCount} file(s) changed.`);
	for (const c of check.commits.slice(0, 20)) lines.push(`  ${c.sha} ${c.subject}`);
	lines.push(`Steps: ${check.steps.length ? check.steps.join(', ') : 'none'}`);
	for (const m of check.migrations) lines.push(`Migration ${m.file}${m.destructive.length ? ` (destructive: ${m.destructive.join(', ')})` : ''}`);
	if (check.dirty.length) lines.push(`Uncommitted: ${check.dirty.join(', ')}`);
	for (const h of check.holders) lines.push(`Holding node_modules: ${h.name} (pid ${h.pid}) ${h.reason}`);
	for (const b of check.blockers) lines.push(`BLOCKED (${b.code}): ${b.message}`);
	if (check.needsAck.length) lines.push(`Needs acknowledgement: ${check.needsAck.join(', ')}`);
	return lines.join('\n');
}

function dbmateArgs(ctx, dbDir, network, tail) {
	return ['run', '--rm', '--network', network, '-e', 'DATABASE_URL', '-v', `${dbDir}:/db`, DBMATE_IMAGE, ...tail];
}

/** `run`: preflight, then migrate -> merge -> install -> build -> restart -> verify. Resolves with the result object. */
export async function runDeploy(ctx, opts = {}) {
	const { repoDir } = ctx;
	const startMs = ctx.now();
	const result = {
		id: opts.id ?? formatRunId(new Date(startMs)),
		ok: false,
		startedAt: iso(startMs),
		finishedAt: null,
		actor: opts.actor ?? null,
		branch: null,
		fromSha: null,
		toSha: null,
		steps: [],
		backup: null,
		failedStep: null,
		message: '',
	};
	const ack = new Set(opts.ack ?? []);
	let worktree = false;
	let check = null;
	let migrated = false;
	let merged = false; // the merge is in HEAD (this run's, or an earlier unfinished run's)
	let resumed = false;
	const pendingPath = path.join(repoDir, PENDING_FILE);
	/** Record that the merge landed, so a failure after it can be finished later (see readUnfinished). */
	const writePending = (fromSha) =>
		ctx.fsx.writeText(
			pendingPath,
			`${JSON.stringify({ runId: result.id, fromSha, failedStep: result.failedStep, message: result.message, at: iso(ctx.now()) }, null, 2)}\n`,
		);

	const envText = ctx.fsx.readText(path.join(repoDir, '.env'));
	const envFile = parseEnv(envText);
	const setting = (k, d) => ctx.env[k] || envFile[k] || d;

	async function step(name, fn) {
		ctx.out(`##STEP ${name}\n`);
		const t = ctx.now();
		try {
			await fn();
			result.steps.push({ name, ok: true, ms: ctx.now() - t });
		} catch (e) {
			result.steps.push({ name, ok: false, ms: ctx.now() - t });
			result.failedStep = name;
			result.message = e instanceof StepError || e instanceof Error ? e.message : String(e);
			ctx.out(`FAILED: ${result.message}\n`);
			throw e;
		}
	}
	function skip(name, why) {
		ctx.out(`##STEP ${name}\nskipped: ${why}\n`);
		result.steps.push({ name, ok: true, ms: 0, skipped: true });
	}
	const has = (s) => check.steps.includes(s);

	/** Refuse when the checkout is not exactly what preflight looked at (a branch switch, a commit, a pull). */
	async function assertCheckoutUnmoved() {
		const branch = (await git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
		const head = (await git(ctx, ['rev-parse', 'HEAD'])).stdout.trim();
		if (branch !== check.branch) {
			throw new StepError(`The live checkout changed branch since the preflight (${check.branch} -> ${branch || 'unknown'}); nothing was merged. Check it, then deploy again.`);
		}
		if (head !== check.headSha) {
			throw new StepError(`The live checkout moved since the preflight (${check.head} -> ${head.slice(0, 8) || 'unknown'}); nothing was merged. Check it, then deploy again.`);
		}
	}

	try {
		await step('preflight', async () => {
			check = await computeCheck(ctx);
			result.branch = check.branch;
			result.fromSha = check.head;
			result.toSha = check.target;
			ctx.out(`${summarise(check)}\n`);
			if (check.upToDate) return;
			if (check.blockers.length) {
				throw new StepError(`Not deploying: ${check.blockers.map((b) => b.message).join(' ')} Nothing was changed.`);
			}
			const missing = check.needsAck.filter((f) => !ack.has(f));
			const missingMigrations = missing.filter((f) => f !== STOP_HOLDERS_ACK);
			if (missingMigrations.length) {
				throw new StepError(`Not deploying: these migrations need an explicit acknowledgement first: ${missingMigrations.join(', ')}. Nothing was changed.`);
			}
			if (missing.includes(STOP_HOLDERS_ACK)) {
				const who = check.holders.map((h) => `${h.name} (pid ${h.pid})`).join(', ');
				throw new StepError(`Not deploying: ${who} hold files in node_modules, so npm install would fail. Stop them yourself, or confirm that the deploy may stop them. Nothing was changed.`);
			}
		});

		if (check.upToDate) {
			result.ok = true;
			result.toSha = result.fromSha;
			result.message = 'Already up to date, nothing to deploy.';
			return result;
		}

		// ---- worktree + migrate (before the merge: Directus hot-loads new code, so the schema must be ready first)
		const migrate = has('migrate');
		if (check.resume) {
			// An earlier run already merged (and migrated); only its unfinished steps are left.
			resumed = true;
			merged = true;
			result.fromSha = check.resume.fromSha.slice(0, 8);
			for (const name of ['worktree', 'migrate', 'merge']) skip(name, `finishing run ${check.resume.runId ?? 'an earlier run'}: already done`);
		} else if (migrate) {
			await step('worktree', async () => {
				await git(ctx, ['worktree', 'remove', '--force', WORKTREE_REL]); // a stale one; failure is fine
				await git(ctx, ['worktree', 'prune']);
				must(await git(ctx, ['worktree', 'add', '-q', '--detach', WORKTREE_REL, check.targetSha], { onData: ctx.onData, timeoutMs: T.checkout }), 'git worktree add');
				worktree = true;
			});
			await step('migrate', async () => {
				await assertCheckoutUnmoved();
				const dbUrl = envFile.DATABASE_URL;
				if (!dbUrl) throw new StepError('DATABASE_URL is not set in .env.');
				const network = setting('DEPLOY_DOCKER_NETWORK', 'd1-database_d1net');
				const dbDir = path.join(repoDir, ...WORKTREE_REL.split('/'), 'db');
				const env = { ...ctx.env, DATABASE_URL: rewriteDbUrl(dbUrl) };
				const dbmate = (tail) => ctx.exec('docker', dbmateArgs(ctx, dbDir, network, tail), { cwd: repoDir, env, onData: ctx.onData, timeoutMs: T.dbmate });
				const status = await dbmate(['status']);
				if (status.code !== 0) throw new StepError(`dbmate status failed: ${status.code === -2 ? 'timed out' : (status.stderr || status.stdout).trim().split('\n').slice(-2).join(' | ')}`);
				const pending = parsePending(status.stdout);
				if (pending === 0) {
					ctx.out('No pending migrations, no backup taken.\n');
					return;
				}
				// Only migrations that were scanned (added or changed by this update) may be applied. A pending one that is
				// not among them was never looked at: leave it to a person.
				const pendingFiles = parsePendingFiles(status.stdout);
				if (pendingFiles.length === 0) {
					throw new StepError(`dbmate reports ${pending} pending migration(s) but its status output could not be read, so they cannot be checked against this update. Nothing was applied; use /starbase-deploy.`);
				}
				const scanned = new Set(check.migrations.map((m) => m.file.split('/').pop()));
				const unknown = pendingFiles.filter((f) => !scanned.has(f));
				if (unknown.length) {
					throw new StepError(
						`Migration ${unknown.join(', ')} is pending but not part of this update; deploy it with /starbase-deploy. Nothing was applied and no backup was taken.`,
					);
				}
				ctx.out(`${pending} pending migration(s). Backing up first.\n`);
				const bash = setting('DEPLOY_BASH', 'C:\\Program Files\\Git\\bin\\bash.exe');
				const b = await ctx.exec(bash, ['infra/backup/backup.sh'], { cwd: repoDir, onData: ctx.onData, timeoutMs: T.backup });
				if (b.code !== 0) throw new StepError(`Backup failed (${why(b)}); no migration was applied.`);
				result.backup = parseBackupName(b.stdout) ?? 'unknown';
				const up = await dbmate(['--no-dump-schema', 'up']);
				if (up.code !== 0) {
					throw new StepError(`dbmate up failed (${why(up)}). The backup is ${result.backup}; check the database before retrying.`);
				}
				migrated = true;
			});
		} else {
			skip('worktree', 'no migrations in this update');
			skip('migrate', 'no migrations in this update');
		}

		// ---- merge
		if (!resumed) await step('merge', async () => {
			await assertCheckoutUnmoved();
			// Merge the sha the preflight looked at, not whatever origin/main is by now.
			const m = await git(ctx, ['merge', '--no-edit', '-m', `Deploy: merge origin/main (${check.target})`, check.targetSha], { onData: ctx.onData, timeoutMs: T.checkout });
			if (m.code !== 0) {
				const conflicted = splitNul((await git(ctx, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=U'])).stdout);
				const abort = await git(ctx, ['merge', '--abort']);
				const where = conflicted.length ? ` in ${conflicted.join(', ')}` : '';
				const tail = migrated ? ` The migration(s) already applied stay in place; backup ${result.backup}.` : '';
				if (abort.code !== 0) {
					throw new StepError(`git merge of origin/main failed${where}, and the merge abort FAILED: the checkout may be mid-merge, fix it by hand (git status, then git merge --abort).${tail}`);
				}
				throw new StepError(`git merge origin/main failed${where}; the merge was aborted and the working tree is as before.${tail}`);
			}
			const head = (await git(ctx, ['rev-parse', '--short=8', 'HEAD'])).stdout.trim();
			if (head) result.toSha = head;
			merged = true;
			writePending(check.headSha);
		});

		// ---- install (never npm ci: a vite dev server from another session can lock node_modules)
		if (has('install')) {
			await step('install', async () => {
				// Stop what holds node_modules, but only what a person confirmed on the page (the ack) and only what is
				// there now, not the list from the check.
				if (ack.has(STOP_HOLDERS_ACK)) {
					const stopped = await stopHolders(ctx);
					if (stopped.length) ctx.out(`Stopped ${stopped.map((h) => `${h.name} (pid ${h.pid})`).join(', ')}, which held files in node_modules.\n`);
				}
				const r = await ctx.exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: repoDir, onData: ctx.onData, timeoutMs: T.install });
				if (r.code !== 0) {
					// 4294963214 is -4082 (EBUSY) as an unsigned exit code.
					const busy = r.code === 4294963214 || r.code === -4082 || /EBUSY/.test(r.stderr ?? '');
					throw new StepError(`npm install failed (${why(r)}).${busy ? ' A running process holds a file in node_modules; press Check to see which, stop it, then resume.' : ''}`);
				}
				// npm install rewrites package-lock.json on this host (a different resolution than CI's). Left
				// dirty, it would block the next deploy as an overlap, so put it back unless it was already
				// dirty before this run (an edit of the maintainer's, which must stay).
				if (!check.dirty.includes('package-lock.json')) {
					const lock = await git(ctx, ['status', '--porcelain', '-z', '--untracked-files=no', '--', 'package-lock.json']);
					if (lock.stdout.trim()) {
						await git(ctx, ['checkout', '--', 'package-lock.json']);
						ctx.out('Restored package-lock.json (npm install rewrote it locally).\n');
					}
				}
			});
		} else skip('install', 'package files unchanged');

		// ---- build
		const builds = check.steps.filter((s) => s.startsWith('build:'));
		if (builds.length) {
			await step('build', async () => {
				for (const b of builds) {
					const script = b; // build:extensions, build:starbase, build:web are root npm scripts
					ctx.out(`npm run ${script}\n`);
					const r = await ctx.exec('npm', ['run', script], { cwd: repoDir, onData: ctx.onData, timeoutMs: T.build });
					if (r.code !== 0) throw new StepError(`npm run ${script} failed (${why(r)}).`);
				}
			});
		} else skip('build', 'nothing to build');

		// ---- restart
		const wants = (s) => check.steps.includes(s);
		const restart = check.steps.some((s) => s === 'compose-up' || s.startsWith('recreate:'));
		const touched = [];
		if (restart) {
			await step('restart', async () => {
				const must0 = async (args, what) => {
					const r = await compose(ctx, args);
					if (r.code !== 0) throw new StepError(`${what} failed (${why(r)}).`);
				};
				// A plain `up -d` touches every service whose definition changed, so only when the compose file itself changed.
				if (wants('compose-up')) await must0(['up', '-d'], 'docker compose up -d');
				if (wants('recreate:directus')) {
					await must0(['up', '-d', '--no-deps', '--force-recreate', 'directus'], 'recreate directus');
					touched.push('directus');
				}
				if (wants('recreate:proxy')) {
					await must0(['up', '-d', '--no-deps', '--force-recreate', 'proxy'], 'recreate proxy');
					touched.push('proxy');
				}
				// Build services and profile-gated services: read from the merged compose file (a service may be new).
				const others = check.steps.filter((s) => s.startsWith('recreate:')).map((s) => s.slice(9)).filter((s) => s !== 'directus' && s !== 'proxy');
				if (!others.length) return;
				const { services, error } = await readBuildServices(ctx);
				if (error) throw new StepError(`docker compose config failed after the merge: ${error}`);
				const psRows = parseComposePs((await compose(ctx, ['--profile', '*', 'ps', '--format', 'json'], { onData: undefined })).stdout);
				const running = runningServices(psRows);
				for (const svc of others) {
					const optionalProfile = OPTIONAL_SERVICES[svc];
					if (optionalProfile) {
						// Opt-in (profile) services: recreated only if already running, never started by a deploy.
						if (running.has(svc)) {
							await must0(['--profile', optionalProfile, 'up', '-d', '--no-deps', '--force-recreate', svc], `recreate ${svc}`);
							touched.push(svc);
						} else ctx.out(`${svc} is not running; left stopped.\n`);
						continue;
					}
					const b = services.find((s) => s.service === svc);
					const prof = (b?.profiles ?? []).flatMap((p) => ['--profile', p]);
					if (!b?.profiles?.length || running.has(svc)) {
						await must0([...prof, 'up', '-d', '--no-deps', '--build', svc], `rebuild ${svc}`);
						touched.push(svc);
					} else {
						await must0([...prof, 'build', svc], `build ${svc}`);
						ctx.out(`${svc} is not running (profile ${b.profiles.join(',')}); image rebuilt, container left stopped.\n`);
					}
				}
			});
		} else skip('restart', 'no service to restart');

		// ---- verify
		if (restart) {
			await step('verify', async () => {
				const all = wants('compose-up');
				const deadline = ctx.now() + VERIFY_TIMEOUT_MS;
				for (;;) {
					const ps = await compose(ctx, ['--profile', '*', 'ps', '-a', '--format', 'json'], { onData: undefined });
					const problems = serviceProblems(parseComposePs(ps.stdout), touched, all);
					if (problems.length === 0) {
						ctx.out(`Services up: ${touched.length ? touched.join(', ') : 'all'}.\n`);
						return;
					}
					if (ctx.now() >= deadline) throw new StepError(`Not healthy after ${VERIFY_TIMEOUT_MS / 1000} s: ${problems.join('; ')}.`);
					ctx.out(`waiting: ${problems.join('; ')}\n`);
					await ctx.sleep(VERIFY_POLL_MS);
				}
			});
		} else skip('verify', 'nothing was restarted');

		// ---- notes: report, never invent values
		await step('notes', async () => {
			const missing = missingEnvKeys(ctx.fsx.readText(path.join(repoDir, '.env.example')), ctx.fsx.readText(path.join(repoDir, '.env')));
			result.missingEnv = missing;
			ctx.out(missing.length ? `Keys in .env.example missing from .env: ${missing.join(', ')}\n` : 'No new .env keys.\n');
		});

		result.ok = true;
		ctx.fsx.remove?.(pendingPath); // nothing is left unfinished
		const n = check.commits.length;
		result.message =
			`${resumed ? 'Finished the earlier deploy:' : 'Deployed'} ${n} commit${n === 1 ? '' : 's'} (${result.fromSha} -> ${result.toSha}).` +
			(result.backup ? ` Backup: ${result.backup}.` : '') +
			(result.missingEnv?.length ? ` Missing .env keys: ${result.missingEnv.join(', ')}.` : '');
		return result;
	} catch (e) {
		result.ok = false;
		if (!result.failedStep) result.failedStep = 'unexpected';
		if (!result.message) result.message = e?.message ?? String(e);
		if (migrated && !result.message.includes(result.backup ?? '\0')) result.message += ` A migration was applied; backup ${result.backup}.`;
		if (merged) {
			try {
				writePending(resumed ? check.resume.fromSha : check.headSha);
				result.message += ' The merge is in place; press Check, then Resume to finish the remaining steps.';
			} catch {
				/* the run's own result still records the failure */
			}
		}
		return result;
	} finally {
		if (worktree) await git(ctx, ['worktree', 'remove', '--force', WORKTREE_REL]);
		result.finishedAt = iso(ctx.now());
	}
}

// ---- CLI -------------------------------------------------------------------------------------

export function parseArgs(argv) {
	const out = { cmd: argv[0], json: false, lockHeld: false, ack: [], id: undefined, actor: undefined, resultFile: undefined };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--json') out.json = true;
		else if (a === '--lock-held') out.lockHeld = true;
		else if (a.startsWith('--ack=')) out.ack.push(a.slice(6));
		else if (a === '--ack') {
			while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.ack.push(argv[++i]);
		} else if (a.startsWith('--id=')) out.id = a.slice(5);
		else if (a === '--id') out.id = argv[++i];
		else if (a.startsWith('--actor=')) out.actor = a.slice(8);
		else if (a === '--actor') out.actor = argv[++i];
		else if (a.startsWith('--result-file=')) out.resultFile = a.slice(14);
		else if (a === '--result-file') out.resultFile = argv[++i];
		else throw new Error(`unknown argument: ${a}`);
	}
	return out;
}

/** Entry point with injectable dependencies; resolves to the process exit code. */
export async function main(argv, deps = {}) {
	const repoDir = deps.repoDir ?? process.env.DEPLOY_REPO_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
	const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
	const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
	let args;
	try {
		args = parseArgs(argv);
		if (!['check', 'run'].includes(args.cmd)) throw new Error('usage: deploy.mjs check|run [--json] [--ack <file>...] [--lock-held] [--id <id>] [--actor <who>] [--result-file <path>]');
	} catch (e) {
		stderr(`${e.message}\n`);
		return 2;
	}
	const fsx = deps.fsx ?? makeFsx();
	const ctx = {
		exec: deps.exec ?? makeExec(),
		repoDir,
		env: deps.env ?? process.env,
		fsx,
		now: deps.now ?? (() => Date.now()),
		sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
		out: stdout,
		onData: (chunk) => stdout(chunk),
	};

	if (args.cmd === 'check') {
		try {
			const check = await computeCheck({ ...ctx, onData: undefined });
			stdout(args.json ? `${JSON.stringify(check)}\n` : `${summarise(check)}\n`);
			return 0;
		} catch (e) {
			stderr(`check failed: ${e.message}\n`);
			return 2;
		}
	}

	// One run at a time. The agent takes the lock itself and says so with --lock-held; a run started by hand takes it here.
	const id = args.id ?? formatRunId(new Date(ctx.now()));
	const lockfs = deps.lockfs ?? makeLockFs(path.join(repoDir, 'logs', 'deploy', '.lock'));
	const isAlive = deps.isAlive ?? isPidAlive;
	if (!args.lockHeld) {
		const got = acquireRunLock(
			lockfs,
			{ id, pid: deps.pid ?? process.pid, startedAt: iso(ctx.now()), actor: args.actor ?? null, source: 'cli' },
			{ isAlive, nowMs: ctx.now(), ownRunIds: new Set() },
		);
		if (!got.ok) {
			const h = got.holder;
			stderr(
				h
					? `Another deploy is running (run ${h.id}, pid ${h.pid}, started ${h.startedAt}). Not starting; wait for it, or see docs/runbooks/deploy-button.md.\n`
					: 'Could not take logs/deploy/.lock. Not starting.\n',
			);
			return 3;
		}
	}
	const stopHeartbeat = startHeartbeat(lockfs, id, deps.heartbeatMs);
	let result;
	try {
		result = await runDeploy(ctx, { id, actor: args.actor, ack: args.ack });
	} finally {
		stopHeartbeat();
		if (!args.lockHeld) releaseRunLock(lockfs, id);
	}
	if (args.resultFile) fsx.writeText(args.resultFile, `${JSON.stringify(result, null, 2)}\n`);
	if (args.json) stdout(`##RESULT ${JSON.stringify(result)}\n`);
	else stdout(`${result.ok ? 'OK' : `FAILED at ${result.failedStep}`}: ${result.message}\n`);
	return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
