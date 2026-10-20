#!/usr/bin/env node
// The deploy agent: a tiny HTTP server on the d1-server host (127.0.0.1 only) that runs
// scripts/deploy/deploy.mjs for the Directus "Deploy" page. Spec: docs/superpowers/specs/2026-10-18-deploy-button-design.md,
// install and recovery: docs/runbooks/deploy-button.md.
//
// Standalone on purpose (node: builtins only, no import from the repo): a deploy replaces files under the repo, and the
// agent must keep running the code it started with. If this file changed during a run it exits with code 75 once the
// run is recorded, and the Scheduled Task's restart-on-failure starts the new one.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUN_ID_RE = /^\d{8}T\d{6}Z$/;
export const KEEP_RUNS = 20;
export const EXIT_SELF_CHANGED = 75;
const CHECK_TIMEOUT_MS = 90_000;
export const DEFAULT_RUN_TIMEOUT_MS = 60 * 60_000; // a run longer than this is killed (DEPLOY_RUN_TIMEOUT_MIN)
export const LOCK_FRESH_MS = 3 * 60_000; // a lock nobody has refreshed for this long is stale even if its pid exists
const MAX_BODY = 64 * 1024;
const MAX_CHUNK = 256 * 1024;

const pad = (n) => String(n).padStart(2, '0');
function formatRunId(date) {
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
	);
}
function runIdToDate(id) {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
	return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

/** KEY=value lines of a dotenv file (a missing file is empty). */
export function parseDotEnv(text) {
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

const sha256 = (s) => createHash('sha256').update(s).digest();
/** Constant-time token comparison: hash both sides so the lengths always match. */
export function tokensEqual(given, expected) {
	if (typeof given !== 'string' || typeof expected !== 'string') return false;
	return timingSafeEqual(sha256(given), sha256(expected));
}

function trimIncompleteUtf8(buf) {
	// Drop a multi-byte character cut by the end of the chunk.
	let i = buf.length - 1;
	let back = 0;
	while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) {
		i--;
		back++;
	}
	if (i < 0) return buf.length;
	const lead = buf[i];
	const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return need > back + 1 ? i : buf.length;
}

export function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

/** Run a command to completion with a timeout; never rejects. */
export function runCommand(cmd, args, { cwd, timeoutMs, env } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { cwd, env: env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (e) {
			resolve({ code: -1, stdout: '', stderr: String(e.message) });
			return;
		}
		let stdout = '';
		let stderr = '';
		let done = false;
		let timer = null;
		const finish = (code, timedOut = false) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		};
		child.stdout.on('data', (c) => (stdout += c));
		child.stderr.on('data', (c) => (stderr += c));
		child.on('error', (e) => {
			stderr += String(e.message);
			finish(-1);
		});
		child.on('close', (code) => finish(code ?? -1));
		if (timeoutMs) {
			timer = setTimeout(() => {
				try {
					if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
					else child.kill('SIGKILL');
				} catch {
					/* gone */
				}
				finish(-2, true);
			}, timeoutMs);
		}
	});
}

/** The real runner. Tests pass a fake with the same methods. */
export function makeRunner(repoDir) {
	const deployScript = path.join(repoDir, 'scripts', 'deploy', 'deploy.mjs');
	return {
		check: () => runCommand(process.execPath, [deployScript, 'check', '--json'], { cwd: repoDir, timeoutMs: CHECK_TIMEOUT_MS }),
		git: (args) => runCommand('git', args, { cwd: repoDir, timeoutMs: 15_000 }),
		/** Start `deploy.mjs run` detached, its output appended to logPath. Returns { pid, exited: Promise<code> }. */
		spawnDeploy: ({ id, ack, actor, logPath, resultFile }) => {
			const fd = openSync(logPath, 'a');
			try {
				const args = [deployScript, 'run', '--json', `--id=${id}`, `--actor=${actor}`, `--result-file=${resultFile}`, '--lock-held', ...ack.map((a) => `--ack=${a}`)];
				const child = spawn(process.execPath, args, { cwd: repoDir, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
				const exited = new Promise((resolve) => {
					child.on('error', () => resolve(-1));
					child.on('exit', (code) => resolve(code ?? -1));
				});
				child.unref();
				return { pid: child.pid, exited };
			} finally {
				closeSync(fd);
			}
		},
		isAlive: isPidAlive,
		/** Kill a run's whole process tree (deploy.mjs and the git, npm and docker commands under it). */
		killTree: (pid) => {
			try {
				if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
				else {
					try {
						process.kill(-pid, 'SIGKILL'); // the run is a process group leader (spawned detached)
					} catch {
						process.kill(pid, 'SIGKILL');
					}
				}
			} catch {
				/* already gone */
			}
		},
	};
}

function parsePorcelainZ(s) {
	const parts = String(s ?? '').split('\0').filter(Boolean);
	const out = [];
	for (let i = 0; i < parts.length; i++) {
		if (parts[i].length < 4) continue;
		const xy = parts[i].slice(0, 2);
		out.push(parts[i].slice(3));
		if (xy.includes('R') || xy.includes('C')) i++;
	}
	return out;
}

const SUMMARY_KEYS = ['id', 'ok', 'startedAt', 'finishedAt', 'actor', 'branch', 'fromSha', 'toSha', 'backup', 'failedStep', 'message'];
const summarise = (r) => Object.fromEntries(SUMMARY_KEYS.map((k) => [k, r[k] ?? null]));

/**
 * Build the agent. Options: repoDir, token (required), port (0 = ephemeral), host, runner, exit(code), exitDelayMs,
 * hashSelf() (the agent's own code hash; defaults to the hash of this file), now().
 */
export function createAgent(opts) {
	const token = opts.token;
	if (!token) throw new Error('DEPLOY_AGENT_TOKEN is not set: refusing to start without a token.');
	const repoDir = opts.repoDir;
	const host = opts.host ?? '127.0.0.1';
	const runner = opts.runner ?? makeRunner(repoDir);
	const exit = opts.exit ?? ((c) => process.exit(c));
	const exitDelayMs = opts.exitDelayMs ?? 3000;
	const now = opts.now ?? (() => Date.now());
	const selfFile = fileURLToPath(import.meta.url);
	const hashSelf = opts.hashSelf ?? (() => createHash('sha256').update(readFileSync(selfFile)).digest('hex'));
	const startHash = hashSelf();
	const runsDir = path.join(repoDir, 'logs', 'deploy');
	const lockPath = path.join(runsDir, '.lock');
	const runDir = (id) => path.join(runsDir, id);
	const timers = new Set();
	const ownRunIds = new Set(); // runs this process started and has not seen finish
	const timedOut = new Set(); // runs killed for exceeding the run limit
	const runTimers = new Map(); // run id -> its timeout timer
	const runTimeoutMs = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	let checking = false;

	// ---- lock ---------------------------------------------------------------------------------
	/** {lock, mtimeMs} or null when there is no lock file; a damaged file gives lock: null. */
	function readLockFile() {
		try {
			const mtimeMs = statSync(lockPath).mtimeMs;
			let lock = null;
			try {
				lock = JSON.parse(readFileSync(lockPath, 'utf8'));
			} catch {
				/* damaged: stale */
			}
			return { lock, mtimeMs };
		} catch {
			return null;
		}
	}
	const readLock = () => readLockFile()?.lock ?? null;
	// A lock is live only if its process exists AND the file was refreshed recently (the running deploy touches it
	// every 20 s): a bare pid can be handed to an unrelated process after a crash or reboot. Same rule as
	// scripts/deploy/lib.mjs lockIsLive (this file stays standalone, so it keeps its own copy).
	function lockIsLive(entry) {
		const lock = entry?.lock;
		if (!lock || !Number.isInteger(lock.pid)) return false;
		if (Date.now() - entry.mtimeMs > LOCK_FRESH_MS) return false;
		if (lock.pid === process.pid) return ownRunIds.has(lock.id); // only a run this very process started (before its child exists)
		return runner.isAlive(lock.pid);
	}
	/** The live lock, or null. */
	function liveLock() {
		const entry = readLockFile();
		return lockIsLive(entry) ? entry.lock : null;
	}
	/** Create the lock file exclusively; remove one that is stale. Returns false when a run is active. */
	function acquireLock(info) {
		mkdirSync(runsDir, { recursive: true });
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = openSync(lockPath, 'wx');
				try {
					writeFileSync(fd, JSON.stringify(info));
				} finally {
					closeSync(fd);
				}
				return true;
			} catch (e) {
				if (e.code !== 'EEXIST') throw e;
				const entry = readLockFile();
				if (lockIsLive(entry)) return false;
				const lock = entry?.lock;
				// Stale: its process is gone, or nobody has refreshed it. Record the run it left behind, then take over.
				if (lock?.id) markInterrupted(lock.id, lock.actor ?? null, lock.startedAt);
				try {
					unlinkSync(lockPath);
				} catch {
					/* raced */
				}
			}
		}
		return false;
	}
	function releaseLock(id) {
		const lock = readLock();
		if (lock && lock.id !== id) return;
		try {
			unlinkSync(lockPath);
		} catch {
			/* already gone */
		}
	}

	// ---- run files ----------------------------------------------------------------------------
	function readResult(id) {
		try {
			return JSON.parse(readFileSync(path.join(runDir(id), 'result.json'), 'utf8'));
		} catch {
			return null;
		}
	}
	function writeResult(id, result) {
		const p = path.join(runDir(id), 'result.json');
		mkdirSync(runDir(id), { recursive: true });
		writeFileSync(`${p}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
		renameSync(`${p}.tmp`, p);
	}
	function failureResult(id, actor, startedAt, failedStep, message) {
		return {
			id,
			ok: false,
			startedAt: startedAt ?? runIdToDate(id)?.toISOString() ?? null,
			finishedAt: new Date(now()).toISOString(),
			actor: actor ?? null,
			branch: null,
			fromSha: null,
			toSha: null,
			steps: [],
			backup: null,
			failedStep,
			message,
		};
	}
	function markInterrupted(id, actor, startedAt) {
		if (!RUN_ID_RE.test(id) || readResult(id) || !existsSync(runDir(id))) return;
		writeResult(id, failureResult(id, actor, startedAt, 'interrupted', 'The deploy agent or the server restarted while this run was in progress. Check the log, the services and the database before running it again.'));
	}
	const listRunIds = () => {
		try {
			return readdirSync(runsDir).filter((n) => RUN_ID_RE.test(n)).sort().reverse();
		} catch {
			return [];
		}
	};
	function prune(activeId) {
		for (const id of listRunIds().slice(KEEP_RUNS)) {
			if (id === activeId) continue;
			try {
				rmSync(runDir(id), { recursive: true, force: true });
			} catch {
				/* keep going */
			}
		}
	}
	function currentStep(id) {
		try {
			const p = path.join(runDir(id), 'run.log');
			const size = statSync(p).size;
			const len = Math.min(size, 64 * 1024);
			const buf = Buffer.alloc(len);
			const fd = openSync(p, 'r');
			try {
				readSync(fd, buf, 0, len, size - len);
			} finally {
				closeSync(fd);
			}
			const all = [...buf.toString('utf8').matchAll(/^##STEP (\S+)/gm)];
			return all.length ? all.at(-1)[1] : null;
		} catch {
			return null;
		}
	}

	// ---- running a deploy ---------------------------------------------------------------------
	function finishRun(id, exitCode, lockInfo) {
		clearTimeout(runTimers.get(id));
		runTimers.delete(id);
		ownRunIds.delete(id);
		if (!existsSync(runDir(id))) {
			// A run started by hand (`deploy.mjs run` takes the same lock): nothing of ours to record.
			releaseLock(id);
			return;
		}
		if (!readResult(id)) {
			if (timedOut.has(id)) {
				writeResult(
					id,
					failureResult(
						id,
						lockInfo?.actor,
						lockInfo?.startedAt,
						'timeout',
						`The run took longer than ${Math.round(runTimeoutMs / 60_000)} minutes and was killed. Check git status (a half-done merge: git merge --abort), docker compose ps and, if a migration ran, the database before running it again.`,
					),
				);
			} else {
				const why = exitCode == null ? 'the process ended' : `deploy.mjs exited with code ${exitCode}`;
				writeResult(id, failureResult(id, lockInfo?.actor, lockInfo?.startedAt, 'crashed', `${why} without recording a result. See the log.`));
			}
		}
		timedOut.delete(id);
		releaseLock(id);
		prune(null);
		if (hashSelf() !== startHash) {
			// The deploy replaced this very file: let the Scheduled Task start the new code.
			const t = setTimeout(() => exit(EXIT_SELF_CHANGED), exitDelayMs);
			t.unref?.();
		}
	}
	function watchPid(id, pid, lockInfo) {
		const t = setInterval(() => {
			if (runner.isAlive(pid)) return;
			clearInterval(t);
			timers.delete(t);
			finishRun(id, null, lockInfo);
		}, 1000);
		t.unref?.();
		timers.add(t);
	}
	/** Kill the run's whole process tree when it has been going longer than the run limit. */
	function armTimeout(id, pid, startedMs) {
		if (!runTimeoutMs) return;
		const delay = Math.max(0, startedMs + runTimeoutMs - Date.now());
		const t = setTimeout(() => {
			runTimers.delete(id);
			if (!runner.isAlive(pid)) return;
			timedOut.add(id);
			runner.killTree(pid);
		}, delay);
		t.unref?.();
		runTimers.set(id, t);
	}
	function freshId() {
		let d = new Date(now());
		while (existsSync(runDir(formatRunId(d)))) d = new Date(d.getTime() + 1000);
		return formatRunId(d);
	}
	/** Returns { id } or null when busy. */
	function startRun(actor, ack) {
		if (checking) return null;
		const id = freshId();
		const info = { id, pid: process.pid, startedAt: new Date(now()).toISOString(), actor };
		ownRunIds.add(id);
		if (!acquireLock(info)) {
			ownRunIds.delete(id);
			return null;
		}
		mkdirSync(runDir(id), { recursive: true });
		const logPath = path.join(runDir(id), 'run.log');
		writeFileSync(logPath, '');
		try {
			const { pid, exited } = runner.spawnDeploy({ id, ack, actor, logPath, resultFile: path.join(runDir(id), 'result.json') });
			info.pid = pid;
			writeFileSync(lockPath, JSON.stringify(info));
			armTimeout(id, pid, Date.parse(info.startedAt));
			exited.then((code) => finishRun(id, code, info)).catch((e) => console.error(`deploy-agent: finishing run ${id} failed: ${e.message}`));
		} catch (e) {
			writeResult(id, failureResult(id, actor, info.startedAt, 'spawn', `Could not start deploy.mjs: ${e.message}`));
			ownRunIds.delete(id);
			releaseLock(id);
		}
		return { id };
	}
	/** On start: finish what a previous agent left behind. */
	function recover() {
		const entry = readLockFile();
		const lock = entry?.lock;
		let adopted = null;
		if (entry) {
			if (lock && lockIsLive(entry) && lock.pid !== process.pid) {
				adopted = lock.id;
				watchPid(lock.id, lock.pid, lock);
				if (lock.source !== 'cli') armTimeout(lock.id, lock.pid, Date.parse(lock.startedAt) || Date.now());
			} else {
				// stale (process gone, not refreshed, or a damaged file)
				if (lock?.id) markInterrupted(lock.id, lock.actor ?? null, lock.startedAt);
				releaseLock(lock?.id);
			}
		}
		for (const id of listRunIds()) {
			if (id !== adopted) markInterrupted(id, null, null);
		}
		prune(adopted);
	}

	// ---- http ---------------------------------------------------------------------------------
	const send = (res, status, body) => {
		const text = JSON.stringify(body);
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
		res.end(text);
	};
	const err = (res, status, code, message) => send(res, status, { code, message });

	function readBody(req) {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks = [];
			req.on('data', (c) => {
				size += c.length;
				if (size > MAX_BODY) {
					reject(Object.assign(new Error('body too large'), { status: 413 }));
					req.destroy();
					return;
				}
				chunks.push(c);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	function validAck(v) {
		return Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 300);
	}
	const cleanActor = (v) => String(v ?? '').replace(/[^\w.@:-]/g, '_').slice(0, 100) || 'unknown';

	async function repoState() {
		const [b, h, s] = await Promise.all([
			runner.git(['rev-parse', '--abbrev-ref', 'HEAD']),
			runner.git(['rev-parse', '--short=8', 'HEAD']),
			runner.git(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=no']),
		]);
		return {
			branch: b.code === 0 ? b.stdout.trim() : null,
			head: h.code === 0 ? h.stdout.trim() : null,
			dirty: s.code === 0 ? parsePorcelainZ(s.stdout) : [],
		};
	}

	async function handle(req, res) {
		const url = new URL(req.url, 'http://localhost');
		const route = url.pathname.replace(/\/+$/, '') || '/';
		const method = req.method;

		if (route === '/health' && method === 'GET') return send(res, 200, { ok: true });
		if (!tokensEqual(String(req.headers['x-deploy-token'] ?? ''), token)) return err(res, 401, 'unauthorized', 'Missing or wrong X-Deploy-Token.');

		if (route === '/state' && method === 'GET') {
			const lock = liveLock();
			const running = !!lock;
			const ids = listRunIds();
			let last = null;
			for (const id of ids) {
				const r = readResult(id);
				if (r) {
					last = summarise(r);
					break;
				}
			}
			return send(res, 200, {
				running,
				current: running ? { id: lock.id, startedAt: lock.startedAt, actor: lock.actor ?? null, step: currentStep(lock.id) } : null,
				last,
				repo: await repoState(),
			});
		}

		if (route === '/check' && method === 'POST') {
			if (checking || liveLock()) return err(res, 409, 'busy', 'A check or a deploy is already running.');
			checking = true;
			try {
				const r = await runner.check();
				if (r.timedOut || r.code === -2) return err(res, 504, 'check_timeout', 'The check took longer than 90 seconds.');
				if (r.code !== 0) return err(res, 500, 'check_failed', (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-3).join(' | '));
				let parsed;
				try {
					parsed = JSON.parse(r.stdout);
				} catch {
					return err(res, 500, 'check_failed', 'The check printed something that is not JSON.');
				}
				return send(res, 200, parsed);
			} finally {
				checking = false;
			}
		}

		if (route === '/deploy' && method === 'POST') {
			let body = {};
			try {
				const text = await readBody(req);
				if (text.trim()) body = JSON.parse(text);
			} catch (e) {
				if (e.status === 413) return err(res, 413, 'too_large', 'Request body too large.');
				return err(res, 400, 'bad_request', 'Body must be JSON.');
			}
			if (body === null || typeof body !== 'object' || Array.isArray(body)) return err(res, 400, 'bad_request', 'Body must be a JSON object.');
			const ack = body.ack ?? [];
			if (!validAck(ack)) return err(res, 400, 'bad_request', 'ack must be an array of at most 50 strings of at most 300 characters.');
			const started = startRun(cleanActor(req.headers['x-deploy-actor']), ack);
			if (!started) return err(res, 409, 'busy', 'A deploy or a check is already running.');
			return send(res, 202, { id: started.id });
		}

		if (route === '/runs' && method === 'GET') {
			const out = [];
			for (const id of listRunIds()) {
				const r = readResult(id);
				if (r) out.push(summarise(r));
				if (out.length >= KEEP_RUNS) break;
			}
			return send(res, 200, out);
		}

		const m = /^\/runs\/([^/]+)$/.exec(route);
		if (m && method === 'GET') {
			const id = m[1];
			if (!RUN_ID_RE.test(id)) return err(res, 400, 'bad_request', 'Run id must look like 20261018T120000Z.');
			const rawOffset = url.searchParams.get('offset');
			if (rawOffset !== null && !/^\d+$/.test(rawOffset)) return err(res, 400, 'bad_request', 'offset must be a non-negative integer.');
			if (!existsSync(runDir(id))) return err(res, 404, 'not_found', 'No such run.');
			const offset = rawOffset === null ? 0 : Number(rawOffset);
			const result = readResult(id);
			let log = '';
			let nextOffset = offset;
			try {
				const p = path.join(runDir(id), 'run.log');
				const size = statSync(p).size;
				if (offset >= size) nextOffset = size;
				else {
					const len = Math.min(size - offset, MAX_CHUNK);
					const buf = Buffer.alloc(len);
					const fd = openSync(p, 'r');
					try {
						readSync(fd, buf, 0, len, offset);
					} finally {
						closeSync(fd);
					}
					// Never cut a multi-byte character, not even at the end of a log that is still being written. Only a finished run's last bytes are taken as they are.
					const complete = len === size - offset && result !== null;
					const used = complete ? len : trimIncompleteUtf8(buf);
					log = buf.subarray(0, used).toString('utf8');
					nextOffset = offset + used;
				}
			} catch {
				/* no log yet */
			}
			return send(res, 200, { id, done: result !== null, result, log, nextOffset });
		}

		const known = ['/state', '/check', '/deploy', '/runs'];
		if (known.includes(route) || m) return err(res, 405, 'method_not_allowed', `${method} is not allowed here.`);
		return err(res, 404, 'not_found', 'Unknown route.');
	}

	const server = http.createServer((req, res) => {
		handle(req, res).catch((e) => {
			if (!res.headersSent) err(res, 500, 'internal', e?.message ?? 'internal error');
			else res.end();
		});
	});

	return {
		server,
		recover,
		/** Listen on host:port (0 picks a free port). Resolves with the bound port. */
		start(port = opts.port ?? 8212) {
			recover();
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, () => resolve(server.address().port));
			});
		},
		close() {
			for (const t of timers) clearInterval(t);
			timers.clear();
			return new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		},
	};
}

// ---- entry point -------------------------------------------------------------------------------

export async function main(env = process.env) {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repoDir = path.resolve(env.DEPLOY_REPO_DIR || path.join(here, '..', '..'));
	let dotenv = {};
	try {
		dotenv = parseDotEnv(readFileSync(path.join(repoDir, '.env'), 'utf8'));
	} catch {
		/* no .env */
	}
	const get = (k) => env[k] || dotenv[k];
	const token = get('DEPLOY_AGENT_TOKEN');
	if (!token) {
		console.error('deploy-agent: DEPLOY_AGENT_TOKEN is not set (in the environment or in .env). Refusing to start.');
		return 1;
	}
	const port = Number(get('DEPLOY_AGENT_PORT') || 8212);
	const runMin = Number(get('DEPLOY_RUN_TIMEOUT_MIN') || 60);
	const agent = createAgent({ repoDir, token, port, runTimeoutMs: Number.isFinite(runMin) && runMin > 0 ? runMin * 60_000 : DEFAULT_RUN_TIMEOUT_MS });
	const bound = await agent.start(port);
	console.log(`deploy-agent: listening on http://127.0.0.1:${bound}, repo ${repoDir}`);
	return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(
		(code) => {
			if (code !== null) process.exit(code);
		},
		(e) => {
			console.error(`deploy-agent: ${e.message}`);
			process.exit(1);
		},
	);
}
