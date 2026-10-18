// Pure helpers and the real process runner for the deploy script (scripts/deploy/deploy.mjs).
// Node 24, node: builtins only. Everything here is deterministic except makeExec().
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---- process runner ---------------------------------------------------------------------------

/**
 * The real process runner. deploy.mjs takes it as `exec` so tests can pass a fake.
 *   exec(cmd, args, { cwd, env, timeoutMs, onData(chunk, 'stdout'|'stderr') }) -> { code, stdout, stderr }
 * Never rejects: a spawn failure is code -1 with the message in stderr. Commands run without a shell, except
 * `npm` on Windows (npm is a .cmd file there); that call must only ever carry fixed arguments.
 */
export function makeExec({ platform = process.platform } = {}) {
	return function exec(cmd, args = [], opts = {}) {
		return new Promise((resolve) => {
			const shell = platform === 'win32' && cmd === 'npm';
			let child;
			try {
				child = spawn(cmd, args, {
					cwd: opts.cwd,
					env: opts.env ?? process.env,
					shell,
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (e) {
				resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) });
				return;
			}
			const CAP = 16 * 1024 * 1024;
			let stdout = '';
			let stderr = '';
			let settled = false;
			let timer = null;
			const finish = (code) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve({ code, stdout, stderr });
			};
			child.stdout.on('data', (c) => {
				const s = c.toString('utf8');
				if (stdout.length < CAP) stdout += s;
				opts.onData?.(s, 'stdout');
			});
			child.stderr.on('data', (c) => {
				const s = c.toString('utf8');
				if (stderr.length < CAP) stderr += s;
				opts.onData?.(s, 'stderr');
			});
			child.on('error', (e) => {
				stderr += String(e?.message ?? e);
				finish(-1);
			});
			child.on('close', (code) => finish(code ?? -1));
			if (opts.timeoutMs) {
				timer = setTimeout(() => {
					stderr += `\ntimed out after ${opts.timeoutMs} ms`;
					killTree(child, platform);
					finish(-2);
				}, opts.timeoutMs);
			}
		});
	};
}

export function killTree(child, platform = process.platform) {
	try {
		if (platform === 'win32' && child.pid) {
			spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
		} else {
			child.kill('SIGKILL');
		}
	} catch {
		/* already gone */
	}
}

// ---- small parsers ----------------------------------------------------------------------------

export function splitNul(s) {
	return String(s ?? '').split('\0').filter(Boolean);
}

/** `git status --porcelain -z --untracked-files=no` -> the paths of tracked files with uncommitted edits. */
export function parsePorcelainZ(s) {
	const parts = splitNul(s);
	const out = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		out.push(entry.slice(3));
		// A rename/copy carries the old path as the next NUL field.
		if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
			if (parts[i + 1]) out.push(parts[i + 1]);
			i++;
		}
	}
	return [...new Set(out)];
}

/** dirty files that the update also changes. */
export function overlap(dirty, changed) {
	const c = new Set(changed);
	return dirty.filter((f) => c.has(f));
}

/**
 * `git merge-tree --write-tree --name-only -z HEAD <sha>`: with -z the output is NUL separated: the tree id, the
 * conflicted paths, an empty field, then the informational messages (the newline form is still understood).
 * Exit 0 clean, 1 conflicts, anything else means "unknown" (git without --write-tree answers with a usage error),
 * reported as null so nothing is claimed.
 */
export function parseMergeTree({ code, stdout }) {
	if (code === 0) return [];
	if (code !== 1) return null;
	const text = String(stdout ?? '');
	const fields = text.includes('\0') ? text.split('\0') : text.split(/\r?\n/);
	const files = [];
	for (let i = 1; i < fields.length; i++) {
		if (fields[i] === '') break;
		files.push(fields[i]);
	}
	return [...new Set(files)];
}

/** Parse `KEY=value` lines (comments and blanks ignored, one pair<->quote layer and \r stripped). */
export function parseEnv(text) {
	const out = {};
	for (const raw of String(text ?? '').split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (/^\s*(#|$)/.test(line)) continue;
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2].trim();
		if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

/** Keys that .env.example sets (uncommented) and .env lacks. Report only; the caller never invents values. */
export function missingEnvKeys(exampleText, envText) {
	const example = Object.keys(parseEnv(exampleText));
	const have = new Set(Object.keys(parseEnv(envText)));
	return example.filter((k) => !have.has(k));
}

/** A host-side DATABASE_URL points at localhost; inside the compose network the database is postgres:5432. */
export function rewriteDbUrl(url) {
	return String(url).replace(/@(localhost|127\.0\.0\.1):\d+\//, '@postgres:5432/');
}

/** `dbmate status` -> number of pending migrations. */
export function parsePending(stdout) {
	const m = /Pending:\s*(\d+)/i.exec(stdout ?? '');
	if (m) return Number(m[1]);
	return (String(stdout ?? '').match(/^\[ \]/gm) ?? []).length;
}

/** The pending migration file names listed by `dbmate status` (lines like `[ ] 202610180900_x.sql`). */
export function parsePendingFiles(stdout) {
	return [...String(stdout ?? '').matchAll(/^\[ \]\s+(\S+)/gm)].map((m) => m[1]);
}

/** The dump's file name from backup.sh's "Local copy : <path>" line. */
export function parseBackupName(stdout) {
	const m = /Local copy\s*:\s*(.+)/.exec(stdout ?? '');
	if (!m) return null;
	const p = m[1].trim();
	return p.split(/[\\/]/).pop() || null;
}

/** `docker compose ps --format json`: newer compose prints one object per line, older prints an array. */
export function parseComposePs(stdout) {
	const s = String(stdout ?? '').trim();
	if (!s) return [];
	if (s.startsWith('[')) {
		try {
			return JSON.parse(s);
		} catch {
			return [];
		}
	}
	const out = [];
	for (const line of s.split(/\r?\n/)) {
		const t = line.trim();
		if (!t.startsWith('{')) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			/* skip a damaged line */
		}
	}
	return out;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** YYYYMMDDTHHMMSSZ (UTC). */
export function formatRunId(date) {
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
	);
}

export const RUN_ID_RE = /^\d{8}T\d{6}Z$/;

/** The start time encoded in a run id, or null. */
export function runIdToDate(id) {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
	if (!m) return null;
	return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

// ---- destructive-SQL scan ---------------------------------------------------------------------

/** The text between `-- migrate:up` and `-- migrate:down` (the whole file when the markers are missing). */
export function migrateUpSection(sql) {
	const text = String(sql ?? '');
	const up = /^[ \t]*--[ \t]*migrate:up\b.*$/im.exec(text);
	const start = up ? up.index + up[0].length : 0;
	const rest = text.slice(start);
	const down = /^[ \t]*--[ \t]*migrate:down\b.*$/im.exec(rest);
	return down ? rest.slice(0, down.index) : rest;
}

/**
 * Remove `--` line comments and (nested) block comments, and blank the contents of string literals and quoted
 * identifiers, so a word inside a comment or a COMMENT ON text never counts. Dollar-quoted bodies are kept
 * (a DO block really runs). Scanning is by characters so `'--'` inside a string is not mistaken for a comment.
 */
export function stripSql(sql) {
	const s = String(sql ?? '');
	let out = '';
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		const n = s[i + 1];
		if (c === '-' && n === '-') {
			while (i < s.length && s[i] !== '\n') i++;
		} else if (c === '/' && n === '*') {
			let depth = 1;
			i += 2;
			while (i < s.length && depth > 0) {
				if (s[i] === '/' && s[i + 1] === '*') {
					depth++;
					i += 2;
				} else if (s[i] === '*' && s[i + 1] === '/') {
					depth--;
					i += 2;
				} else i++;
			}
			out += ' ';
		} else if (c === "'" || c === '"') {
			const escapes = c === "'" && /[eE]$/.test(out) && !/[A-Za-z0-9_]$/.test(out.slice(0, -1));
			i++;
			while (i < s.length) {
				if (escapes && s[i] === '\\') {
					i += 2;
					continue;
				}
				if (s[i] === c) {
					if (s[i + 1] === c) {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			out += c + c;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

const DROP_KINDS = [
	['TABLE', /\bDROP\s+TABLE\b/i],
	['COLUMN', /\bDROP\s+COLUMN\b/i],
	['SCHEMA', /\bDROP\s+SCHEMA\b/i],
	['TYPE', /\bDROP\s+TYPE\b/i],
	['FUNCTION', /\bDROP\s+FUNCTION\b/i],
	['VIEW', /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b/i],
	['INDEX', /\bDROP\s+INDEX\b/i],
];

/**
 * Destructive statements in a migration's `migrate:up` section, comments stripped. Returns the labels found, in
 * first-seen order, without duplicates: `DROP TABLE|COLUMN|SCHEMA|TYPE|FUNCTION|VIEW|INDEX`, `TRUNCATE`,
 * `DELETE FROM`, `UPDATE … SET`, `ALTER … DROP`. Conservative: a function body that deletes rows is flagged too.
 */
export function scanDestructive(sql) {
	const body = stripSql(migrateUpSection(sql));
	const found = [];
	const add = (l) => {
		if (!found.includes(l)) found.push(l);
	};
	for (const stmt of body.split(';')) {
		let specific = false;
		for (const [kind, re] of DROP_KINDS) {
			if (re.test(stmt)) {
				add(`DROP ${kind}`);
				specific = true;
			}
		}
		if (/\bTRUNCATE\b/i.test(stmt)) add('TRUNCATE');
		if (/\bDELETE\s+FROM\b/i.test(stmt)) add('DELETE FROM');
		// `ON UPDATE SET NULL` (a foreign key action) is not an UPDATE statement.
		if (/(?<!\bON\s+)\bUPDATE\b[^;]*?\bSET\b/i.test(stmt)) add('UPDATE … SET');
		if (!specific && /\bALTER\b[^;]*?\bDROP\b/i.test(stmt)) add('ALTER … DROP');
	}
	return found;
}

// ---- changed path -> deploy step --------------------------------------------------------------

const under = (p, prefix) => p.startsWith(prefix);

/** package.json at any depth, or the root lockfile. */
export const isPackageFile = (p) => p === 'package-lock.json' || /(^|\/)package\.json$/.test(p);

/**
 * Compose services with a `build:`, from `docker compose --profile "*" config --format json`:
 * [{service, dir, profiles}] where `dir` is the repo-relative directory (posix, trailing slash) whose changes
 * force a rebuild: the build context, or, when the context is the repo root, the Dockerfile's directory.
 * An empty `dir` means the Dockerfile is at the repo root, so any change rebuilds it.
 */
export function buildServicesFromConfig(config, repoRoot) {
	const out = [];
	for (const [service, def] of Object.entries(config?.services ?? {})) {
		if (!def?.build) continue;
		const build = typeof def.build === 'string' ? { context: def.build } : def.build;
		const ctx = path.resolve(repoRoot, build.context ?? '.');
		let rel = path.relative(repoRoot, ctx);
		if (rel === '') {
			const df = path.resolve(ctx, build.dockerfile ?? 'Dockerfile');
			rel = path.dirname(path.relative(repoRoot, df));
			if (rel === '.') rel = '';
		}
		const posix = rel.split(path.sep).join('/').replace(/^\.\//, '');
		out.push({ service, dir: posix === '' ? '' : posix.replace(/\/?$/, '/'), profiles: def.profiles ?? [] });
	}
	return out;
}

/**
 * The deploy steps a set of changed paths needs, in execution order. Mirrors the table in
 * .claude/skills/starbase-deploy/SKILL.md.
 * Step names: migrate, install, build:extensions, build:starbase, build:web, compose-up,
 * recreate:directus, recreate:proxy, recreate:<build service>, recreate:inbox-crawler.
 */
export function planSteps(changed, buildServices = []) {
	const has = (fn) => changed.some(fn);
	const steps = [];
	if (has((p) => under(p, 'db/migrations/'))) steps.push('migrate');
	if (has(isPackageFile)) steps.push('install');

	const extensions = has((p) => under(p, 'packages/d1-ui/') || under(p, 'extensions/') || under(p, 'core/extensions/'));
	const starbase = has((p) => under(p, 'apps/starbase/') || under(p, 'packages/starbase-pages/') || under(p, 'packages/d1-ui/'));
	const web = has((p) => under(p, 'apps/force-app/web/') || under(p, 'packages/force-plotting/'));
	if (extensions) steps.push('build:extensions');
	if (starbase) steps.push('build:starbase');
	if (web) steps.push('build:web');

	if (changed.includes('docker-compose.yml')) steps.push('compose-up');
	if (extensions) steps.push('recreate:directus');
	if (starbase || web) steps.push('recreate:proxy');
	for (const b of buildServices) {
		if (changed.some((p) => b.dir === '' || under(p, b.dir))) steps.push(`recreate:${b.service}`);
	}
	if (has((p) => under(p, 'scripts/inbox_crawler/')) && !steps.includes('recreate:inbox-crawler')) steps.push('recreate:inbox-crawler');
	return steps;
}

// ---- verify ----------------------------------------------------------------------------------

/**
 * Judge `docker compose ps -a --format json` rows. `touched` services (the ones the deploy recreated) must be running
 * and healthy (or have no healthcheck). With `all` true the other services are judged leniently: only one that is
 * restarting, or running but not healthy, counts. Stopped or exited containers are ignored there (ollama, profile
 * services and one-shot jobs are often down on purpose), so a healthy stack never fails the check.
 * Returns human-readable problems; an empty list means everything is up.
 */
export function serviceProblems(rows, touched, all = false) {
	const byService = new Map(rows.map((r) => [r.Service ?? r.Name, r]));
	const problems = [];
	const healthy = (r) => r.State === 'running' && (!r.Health || r.Health === 'healthy');
	for (const name of touched) {
		const r = byService.get(name);
		if (!r) problems.push(`${name}: not running`);
		else if (!healthy(r)) problems.push(`${name}: ${r.State}${r.Health ? ` (${r.Health})` : ''}`);
	}
	if (all) {
		for (const [name, r] of byService) {
			if (touched.includes(name)) continue;
			const unhealthy = r.State === 'restarting' || (r.State === 'running' && r.Health && r.Health !== 'healthy');
			if (unhealthy) problems.push(`${name}: ${r.State}${r.Health ? ` (${r.Health})` : ''}`);
		}
	}
	return problems;
}

/** Services that are currently running, from `docker compose ps` rows. */
export function runningServices(rows) {
	return new Set(rows.filter((r) => r.State === 'running').map((r) => r.Service ?? r.Name));
}

// ---- run lock (logs/deploy/.lock) --------------------------------------------------------------
// One run at a time. The lock file holds {id, pid, startedAt, actor, source?}. A process id alone cannot say whether a
// lock is live: after a crash or a reboot the number can be given to an unrelated process. So a lock is live only if its
// process exists AND the file was refreshed recently: the running deploy touches the file every LOCK_HEARTBEAT_MS.
// (infra/deploy-agent/agent.mjs is standalone and keeps its own copy of this rule; both are tested.)

export const LOCK_FRESH_MS = 3 * 60_000;
export const LOCK_HEARTBEAT_MS = 20_000;

export function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

/**
 * Is this lock held by a run that is still going? `mtimeMs` is the lock file's modification time.
 * `ownRunIds` are runs started by this very process (a lock naming our own pid is live only for those).
 */
export function lockIsLive(lock, mtimeMs, { isAlive = isPidAlive, nowMs = Date.now(), ownPid = process.pid, ownRunIds = new Set() } = {}) {
	if (!lock || !Number.isInteger(lock.pid)) return false;
	if (nowMs - mtimeMs > LOCK_FRESH_MS) return false;
	if (lock.pid === ownPid) return ownRunIds.has(lock.id);
	return isAlive(lock.pid);
}

/** The real lock file. `read()` is null when there is none; a damaged file reads as `{lock: null, mtimeMs}`. */
export function makeLockFs(lockPath) {
	return {
		createExclusive(text) {
			mkdirSync(path.dirname(lockPath), { recursive: true });
			const fd = openSync(lockPath, 'wx');
			try {
				writeFileSync(fd, text);
			} finally {
				closeSync(fd);
			}
		},
		read() {
			try {
				const mtimeMs = statSync(lockPath).mtimeMs;
				let lock = null;
				try {
					lock = JSON.parse(readFileSync(lockPath, 'utf8'));
				} catch {
					/* damaged: treated as stale */
				}
				return { lock, mtimeMs };
			} catch {
				return null;
			}
		},
		write(text) {
			writeFileSync(lockPath, text);
		},
		remove() {
			try {
				unlinkSync(lockPath);
			} catch {
				/* already gone */
			}
		},
		touch() {
			const now = new Date();
			utimesSync(lockPath, now, now);
		},
	};
}

/**
 * Take the lock. Returns {ok:true} or {ok:false, holder} when a live run holds it. A stale lock (dead process, or not
 * refreshed for LOCK_FRESH_MS) is removed first; `onStale(lock)` lets the caller record what it left behind.
 */
export function acquireRunLock(lockfs, info, { isAlive = isPidAlive, nowMs = Date.now(), ownRunIds, onStale } = {}) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			lockfs.createExclusive(JSON.stringify(info));
			return { ok: true };
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
		}
		const cur = lockfs.read();
		if (cur && lockIsLive(cur.lock, cur.mtimeMs, { isAlive, nowMs, ownRunIds })) return { ok: false, holder: cur.lock };
		if (cur?.lock) onStale?.(cur.lock);
		lockfs.remove();
	}
	return { ok: false, holder: null };
}

/** Release the lock if it is still ours (the id matches). */
export function releaseRunLock(lockfs, id) {
	const cur = lockfs.read();
	if (cur?.lock && cur.lock.id !== id) return;
	lockfs.remove();
}

/** Refresh the lock file's time every `everyMs` while the run lives. Returns stop(). */
export function startHeartbeat(lockfs, id, everyMs = LOCK_HEARTBEAT_MS) {
	const t = setInterval(() => {
		try {
			const cur = lockfs.read();
			if (cur?.lock?.id === id) lockfs.touch();
		} catch {
			/* a missed beat is covered by the 3 minute margin */
		}
	}, everyMs);
	t.unref?.();
	return () => clearInterval(t);
}
