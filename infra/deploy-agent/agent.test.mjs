// node --test infra/deploy-agent/*.test.mjs
// The agent on an ephemeral port with a fake runner: no test starts git, node or docker.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createAgent, makeRunner, parseDotEnv, tokensEqual } from './agent.mjs';

const TOKEN = 'test-token-123';
const cleanups = [];
after(async () => {
	for (const c of cleanups) await c();
});

function deferred() {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
}

function fakeRunner() {
	const alive = new Set();
	const r = {
		alive,
		runs: [],
		checkResult: { code: 0, stdout: JSON.stringify({ upToDate: true, steps: [] }), stderr: '' },
		checkCalls: 0,
		gitOut: { 'rev-parse --abbrev-ref HEAD': 'feat/x\n', 'rev-parse --short=8 HEAD': 'aaaaaaaa\n', status: ' M docker-compose.yml\0' },
		check: async () => {
			r.checkCalls++;
			if (r.checkGate) await r.checkGate.promise;
			return r.checkResult;
		},
		git: async (args) => {
			const key = args.includes('status') ? 'status' : args.join(' ');
			return { code: 0, stdout: r.gitOut[key] ?? '', stderr: '' };
		},
		spawnDeploy: (o) => {
			const d = deferred();
			const pid = 41000 + r.runs.length;
			alive.add(pid);
			const run = {
				...o,
				pid,
				/** Finish like deploy.mjs would: write the result file (unless null), then exit. */
				finish: (code = 0, result) => {
					if (result !== null) {
						writeFileSync(o.resultFile, JSON.stringify(result ?? { id: o.id, ok: true, startedAt: 'a', finishedAt: 'b', actor: o.actor, branch: 'main', fromSha: 'a', toSha: 'b', steps: [], backup: null, failedStep: null, message: 'done' }));
					}
					alive.delete(pid);
					d.resolve(code);
				},
				log: (text) => writeFileSync(o.logPath, text, { flag: 'a' }),
			};
			r.runs.push(run);
			return { pid, exited: d.promise };
		},
		isAlive: (pid) => alive.has(pid),
	};
	return r;
}

async function boot(extra = {}) {
	const repoDir = mkdtempSync(path.join(tmpdir(), 'deploy-agent-'));
	const runner = extra.runner ?? fakeRunner();
	const exits = [];
	const agent = createAgent({
		repoDir,
		token: TOKEN,
		runner,
		exit: (c) => exits.push(c),
		exitDelayMs: 0,
		hashSelf: extra.hashSelf ?? (() => 'same'),
		...extra.opts,
	});
	const port = await agent.start(0);
	cleanups.push(async () => {
		await agent.close();
		rmSync(repoDir, { recursive: true, force: true });
	});
	const call = async (method, route, { body, headers = {}, token = TOKEN } = {}) => {
		const res = await fetch(`http://127.0.0.1:${port}${route}`, {
			method,
			headers: { ...(token === null ? {} : { 'x-deploy-token': token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
		});
		let json = null;
		try {
			json = await res.json();
		} catch {
			/* no body */
		}
		return { status: res.status, json };
	};
	return { agent, repoDir, runner, exits, call, port, runsDir: path.join(repoDir, 'logs', 'deploy') };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
	const t = Date.now();
	while (Date.now() - t < ms) {
		if (fn()) return;
		await settle(10);
	}
	throw new Error('timed out waiting');
}

test('refuses to start without a token', () => {
	assert.throws(() => createAgent({ repoDir: tmpdir(), token: '' }), /DEPLOY_AGENT_TOKEN/);
	assert.throws(() => createAgent({ repoDir: tmpdir(), token: undefined }), /DEPLOY_AGENT_TOKEN/);
});

test('binds 127.0.0.1 only', async () => {
	const { agent } = await boot();
	assert.equal(agent.server.address().address, '127.0.0.1');
});

test('tokensEqual is exact and length-safe', () => {
	assert.equal(tokensEqual('abc', 'abc'), true);
	assert.equal(tokensEqual('abc', 'abd'), false);
	assert.equal(tokensEqual('abc', 'abcd'), false);
	assert.equal(tokensEqual('', 'abc'), false);
	assert.equal(tokensEqual(undefined, 'abc'), false);
});

test('parseDotEnv', () => {
	assert.deepEqual(parseDotEnv('A=1\n#x\nDEPLOY_AGENT_TOKEN="t k"\r\n'), { A: '1', DEPLOY_AGENT_TOKEN: 't k' });
	assert.deepEqual(parseDotEnv(null), {});
});

test('GET /health needs no token; every other route does', async () => {
	const { call } = await boot();
	assert.deepEqual((await call('GET', '/health', { token: null })).json, { ok: true });
	for (const [m, route] of [['GET', '/state'], ['POST', '/check'], ['POST', '/deploy'], ['GET', '/runs'], ['GET', '/runs/20261018T120000Z']]) {
		assert.equal((await call(m, route, { token: null })).status, 401, route);
		assert.equal((await call(m, route, { token: 'wrong' })).status, 401, route);
	}
	assert.equal((await call('GET', '/state')).status, 200);
});

test('unknown route is 404, wrong method 405', async () => {
	const { call } = await boot();
	assert.equal((await call('GET', '/nope')).status, 404);
	assert.equal((await call('GET', '/deploy')).status, 405);
});

test('GET /state when idle', async () => {
	const { call } = await boot();
	const { status, json } = await call('GET', '/state');
	assert.equal(status, 200);
	assert.deepEqual(json, { running: false, current: null, last: null, repo: { branch: 'feat/x', head: 'aaaaaaaa', dirty: ['docker-compose.yml'] } });
});

test('POST /check relays the check result; failures and timeouts are mapped', async () => {
	const { call, runner } = await boot();
	let r = await call('POST', '/check');
	assert.equal(r.status, 200);
	assert.deepEqual(r.json, { upToDate: true, steps: [] });

	runner.checkResult = { code: 2, stdout: '', stderr: 'check failed: git fetch failed' };
	r = await call('POST', '/check');
	assert.equal(r.status, 500);
	assert.equal(r.json.code, 'check_failed');
	assert.match(r.json.message, /git fetch/);

	runner.checkResult = { code: 0, stdout: 'not json', stderr: '' };
	assert.equal((await call('POST', '/check')).status, 500);

	runner.checkResult = { code: -2, stdout: '', stderr: 'timed out', timedOut: true };
	r = await call('POST', '/check');
	assert.equal(r.status, 504);
	assert.equal(r.json.code, 'check_timeout');
});

test('only one run at a time: a second deploy and a check get 409 busy', async () => {
	const { call, runner } = await boot();
	const a = await call('POST', '/deploy', { body: {}, headers: { 'x-deploy-actor': 'user-1' } });
	assert.equal(a.status, 202);
	assert.match(a.json.id, /^\d{8}T\d{6}Z$/);

	const b = await call('POST', '/deploy', { body: {} });
	assert.equal(b.status, 409);
	assert.equal(b.json.code, 'busy');
	assert.equal((await call('POST', '/check')).status, 409);
	assert.equal(runner.runs.length, 1);

	const s = await call('GET', '/state');
	assert.equal(s.json.running, true);
	assert.equal(s.json.current.id, a.json.id);
	assert.equal(s.json.current.actor, 'user-1');

	runner.runs[0].finish(0);
	await until(() => !existsSync(path.join(runner.runs[0].logPath, '..', '..', '.lock')));
	const after2 = await call('POST', '/deploy', { body: {} });
	assert.equal(after2.status, 202);
	assert.notEqual(after2.json.id, a.json.id);
});

test('a deploy refuses while a check is running', async () => {
	const { call, runner } = await boot();
	runner.checkGate = deferred();
	const pending = call('POST', '/check');
	await until(() => runner.checkCalls === 1);
	assert.equal((await call('POST', '/deploy', { body: {} })).status, 409);
	runner.checkGate.resolve();
	assert.equal((await pending).status, 200);
	assert.equal((await call('POST', '/deploy', { body: {} })).status, 202);
});

test('POST /deploy passes the ack list and a cleaned actor to the runner', async () => {
	const { call, runner } = await boot();
	const ack = ['db/migrations/a b.sql', '--json'];
	const r = await call('POST', '/deploy', { body: { ack }, headers: { 'x-deploy-actor': 'u 1;rm -rf /' } });
	assert.equal(r.status, 202);
	assert.deepEqual(runner.runs[0].ack, ack);
	assert.equal(runner.runs[0].actor, 'u_1_rm_-rf__');
	assert.equal(runner.runs[0].id, r.json.id);
	assert.ok(runner.runs[0].logPath.endsWith(path.join(r.json.id, 'run.log')));
	assert.ok(runner.runs[0].resultFile.endsWith(path.join(r.json.id, 'result.json')));
});

test('POST /deploy validates the body', async () => {
	const { call, runner } = await boot();
	for (const body of [
		{ ack: 'x' },
		{ ack: [1] },
		{ ack: [''] },
		{ ack: ['x'.repeat(301)] },
		{ ack: Array.from({ length: 51 }, (_, i) => `f${i}`) },
		[],
		'not json',
	]) {
		const r = await call('POST', '/deploy', { body });
		assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
		assert.equal(r.json.code, 'bad_request');
	}
	assert.equal(runner.runs.length, 0);
	// the limits themselves are accepted
	const ok = await call('POST', '/deploy', { body: { ack: Array.from({ length: 50 }, () => 'x'.repeat(300)) } });
	assert.equal(ok.status, 202);
});

test('GET /runs/:id reads the log from an offset and reports done with the result', async () => {
	const { call, runner } = await boot();
	const { json } = await call('POST', '/deploy', { body: {} });
	const id = json.id;
	runner.runs[0].log('##STEP preflight\nhello\n');

	let r = await call('GET', `/runs/${id}`);
	assert.equal(r.status, 200);
	assert.equal(r.json.done, false);
	assert.equal(r.json.result, null);
	assert.equal(r.json.log, '##STEP preflight\nhello\n');
	assert.equal(r.json.nextOffset, Buffer.byteLength('##STEP preflight\nhello\n'));

	const first = r.json.nextOffset;
	runner.runs[0].log('##STEP merge\nmore\n');
	r = await call('GET', `/runs/${id}?offset=${first}`);
	assert.equal(r.json.log, '##STEP merge\nmore\n');
	assert.equal(r.json.nextOffset, first + Buffer.byteLength('##STEP merge\nmore\n'));

	// nothing new: empty log, same offset
	const again = await call('GET', `/runs/${id}?offset=${r.json.nextOffset}`);
	assert.equal(again.json.log, '');
	assert.equal(again.json.nextOffset, r.json.nextOffset);

	// the state shows the current step
	assert.equal((await call('GET', '/state')).json.current.step, 'merge');

	runner.runs[0].finish(0);
	await until(async () => true);
	await settle(50);
	r = await call('GET', `/runs/${id}?offset=${again.json.nextOffset}`);
	assert.equal(r.json.done, true);
	assert.equal(r.json.result.ok, true);
	assert.equal(r.json.result.id, id);

	// an offset past the end is clamped
	r = await call('GET', `/runs/${id}?offset=999999`);
	assert.equal(r.json.log, '');
	assert.equal(r.json.nextOffset, Buffer.byteLength('##STEP preflight\nhello\n##STEP merge\nmore\n'));
});

test('GET /runs/:id does not split a multi-byte character across chunks', async () => {
	const { call, runner } = await boot();
	const { json } = await call('POST', '/deploy', { body: {} });
	runner.runs[0].log('é'.repeat(200_000)); // 400,000 bytes, over the 256 KiB chunk
	let offset = 0;
	let text = '';
	for (let i = 0; i < 5; i++) {
		const r = await call('GET', `/runs/${json.id}?offset=${offset}`);
		text += r.json.log;
		if (r.json.nextOffset === offset) break;
		offset = r.json.nextOffset;
	}
	assert.equal(text, 'é'.repeat(200_000));
	assert.ok(!text.includes('�'));
});

test('GET /runs/:id validates the id and offset', async () => {
	const { call } = await boot();
	assert.equal((await call('GET', '/runs/nope')).status, 400);
	assert.equal((await call('GET', '/runs/20261018T120000Z?offset=-1')).status, 400);
	assert.equal((await call('GET', '/runs/20261018T120000Z?offset=abc')).status, 400);
	assert.equal((await call('GET', '/runs/20261018T120000Z?offset=1.5')).status, 400);
	assert.equal((await call('GET', '/runs/20261018T120000Z')).status, 404);
});

test('a stale lock (dead process) is removed and the earlier run is recorded as interrupted', async () => {
	const { call, runner, runsDir } = await boot();
	mkdirSync(path.join(runsDir, '20260101T000000Z'), { recursive: true });
	writeFileSync(path.join(runsDir, '20260101T000000Z', 'run.log'), '##STEP merge\n');
	writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ id: '20260101T000000Z', pid: 999999, startedAt: '2026-01-01T00:00:00.000Z', actor: 'old' }));
	assert.equal((await call('GET', '/state')).json.running, false);

	const r = await call('POST', '/deploy', { body: {} });
	assert.equal(r.status, 202);
	assert.equal(runner.runs.length, 1);
	const old = JSON.parse(readFileSync(path.join(runsDir, '20260101T000000Z', 'result.json'), 'utf8'));
	assert.equal(old.ok, false);
	assert.equal(old.failedStep, 'interrupted');
	assert.equal(old.actor, 'old');
});

test('a lock whose process is alive blocks a new deploy', async () => {
	const { call, runner, runsDir } = await boot();
	runner.alive.add(777);
	mkdirSync(runsDir, { recursive: true });
	writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ id: '20260101T000000Z', pid: 777, startedAt: 'x', actor: 'a' }));
	const r = await call('POST', '/deploy', { body: {} });
	assert.equal(r.status, 409);
	assert.equal(runner.runs.length, 0);
	assert.equal((await call('GET', '/state')).json.running, true);
});

test('starting with an unfinished run and a dead pid records interrupted', async () => {
	const repoDir = mkdtempSync(path.join(tmpdir(), 'deploy-agent-'));
	const runsDir = path.join(repoDir, 'logs', 'deploy');
	mkdirSync(path.join(runsDir, '20260102T030405Z'), { recursive: true });
	writeFileSync(path.join(runsDir, '20260102T030405Z', 'run.log'), '##STEP install\n');
	writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ id: '20260102T030405Z', pid: 123456, startedAt: '2026-01-02T03:04:05.000Z', actor: 'me' }));
	const runner = fakeRunner();
	const agent = createAgent({ repoDir, token: TOKEN, runner, exit: () => {}, hashSelf: () => 'x' });
	const port = await agent.start(0);
	cleanups.push(async () => {
		await agent.close();
		rmSync(repoDir, { recursive: true, force: true });
	});
	const res = await (await fetch(`http://127.0.0.1:${port}/runs`, { headers: { 'x-deploy-token': TOKEN } })).json();
	assert.equal(res.length, 1);
	assert.equal(res[0].id, '20260102T030405Z');
	assert.equal(res[0].ok, false);
	assert.equal(res[0].failedStep, 'interrupted');
	assert.equal(res[0].actor, 'me');
	assert.equal(existsSync(path.join(runsDir, '.lock')), false);
});

test('a run still alive after an agent restart is adopted and finished when its process ends', async () => {
	const repoDir = mkdtempSync(path.join(tmpdir(), 'deploy-agent-'));
	const runsDir = path.join(repoDir, 'logs', 'deploy');
	mkdirSync(path.join(runsDir, '20260102T030405Z'), { recursive: true });
	writeFileSync(path.join(runsDir, '.lock'), JSON.stringify({ id: '20260102T030405Z', pid: 555, startedAt: '2026-01-02T03:04:05.000Z', actor: 'me' }));
	const runner = fakeRunner();
	runner.alive.add(555);
	const agent = createAgent({ repoDir, token: TOKEN, runner, exit: () => {}, hashSelf: () => 'x' });
	const port = await agent.start(0);
	cleanups.push(async () => {
		await agent.close();
		rmSync(repoDir, { recursive: true, force: true });
	});
	const get = async (route) => (await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-deploy-token': TOKEN } })).json();
	assert.equal((await get('/state')).running, true);
	assert.equal(existsSync(path.join(runsDir, '20260102T030405Z', 'result.json')), false);
	runner.alive.delete(555); // the process ends without writing a result
	await until(() => existsSync(path.join(runsDir, '20260102T030405Z', 'result.json')), 4000);
	assert.equal((await get('/state')).running, false);
	assert.equal((await get('/runs'))[0].failedStep, 'crashed');
});

test('a run whose process exits without a result is recorded as crashed', async () => {
	const { call, runner } = await boot();
	const { json } = await call('POST', '/deploy', { body: {} });
	runner.runs[0].finish(3, null);
	await until(() => existsSync(path.join(path.dirname(runner.runs[0].logPath), 'result.json')));
	const r = await call('GET', `/runs/${json.id}`);
	assert.equal(r.json.done, true);
	assert.equal(r.json.result.ok, false);
	assert.equal(r.json.result.failedStep, 'crashed');
	assert.match(r.json.result.message, /code 3/);
});

test('keeps the newest 20 runs and deletes older ones', async () => {
	const { call, runner, runsDir } = await boot();
	mkdirSync(runsDir, { recursive: true });
	for (let i = 1; i <= 25; i++) {
		const id = `2026010${i < 10 ? i : 9}T0000${String(i).padStart(2, '0')}Z`;
		mkdirSync(path.join(runsDir, id), { recursive: true });
		writeFileSync(path.join(runsDir, id, 'result.json'), JSON.stringify({ id, ok: true }));
	}
	const before = readdirSync(runsDir).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).length;
	assert.equal(before, 25);
	const { json } = await call('POST', '/deploy', { body: {} });
	runner.runs[0].finish(0);
	await until(() => readdirSync(runsDir).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).length === 20);
	const left = readdirSync(runsDir).filter((n) => /^\d{8}T\d{6}Z$/.test(n));
	assert.ok(left.includes(json.id));
	const runs = await call('GET', '/runs');
	assert.equal(runs.json.length, 20);
});

test('GET /runs lists summaries, newest first, without the log', async () => {
	const { call, runner } = await boot();
	const a = await call('POST', '/deploy', { body: {} });
	runner.runs[0].finish(0);
	await until(() => runner.alive.size === 0);
	await settle(50);
	const list = await call('GET', '/runs');
	assert.equal(list.status, 200);
	assert.equal(list.json[0].id, a.json.id);
	assert.deepEqual(Object.keys(list.json[0]).sort(), ['actor', 'backup', 'branch', 'failedStep', 'finishedAt', 'fromSha', 'id', 'message', 'ok', 'startedAt', 'toSha']);
	assert.equal((await call('GET', '/state')).json.last.id, a.json.id);
});

test('exits 75 once the run is recorded when agent.mjs changed during it', async () => {
	let hash = 'v1';
	const { call, runner, exits } = await boot({ hashSelf: () => hash });
	await call('POST', '/deploy', { body: {} });
	hash = 'v2'; // the deploy replaced this file
	runner.runs[0].finish(0);
	await until(() => exits.length > 0);
	assert.deepEqual(exits, [75]);
	assert.ok(existsSync(path.join(path.dirname(runner.runs[0].logPath), 'result.json')), 'the run is recorded before exiting');
});

test('does not exit when agent.mjs did not change', async () => {
	const { call, runner, exits } = await boot();
	await call('POST', '/deploy', { body: {} });
	runner.runs[0].finish(0);
	await until(() => runner.alive.size === 0);
	await settle(80);
	assert.deepEqual(exits, []);
});

test('run ids never collide within the same second', async () => {
	const fixed = Date.UTC(2026, 9, 18, 12, 0, 0);
	const { call, runner } = await boot({ opts: { now: () => fixed } });
	const a = await call('POST', '/deploy', { body: {} });
	runner.runs[0].finish(0);
	await until(() => runner.alive.size === 0);
	await settle(50);
	const b = await call('POST', '/deploy', { body: {} });
	assert.equal(a.json.id, '20261018T120000Z');
	assert.equal(b.json.id, '20261018T120001Z');
});

// ---- the real runner against a stub deploy.mjs (spawns node itself only) -----------------------

test('makeRunner.spawnDeploy: detached child, output appended to the log, result file with spaces in the path, ack as single args', async () => {
	const repoDir = mkdtempSync(path.join(tmpdir(), 'deploy agent real '));
	cleanups.push(() => rmSync(repoDir, { recursive: true, force: true }));
	mkdirSync(path.join(repoDir, 'scripts', 'deploy'), { recursive: true });
	writeFileSync(
		path.join(repoDir, 'scripts', 'deploy', 'deploy.mjs'),
		[
			"import { writeFileSync } from 'node:fs';",
			'const args = process.argv.slice(2);',
			"console.log('##STEP preflight');",
			"const rf = args.find((a) => a.startsWith('--result-file=')).slice(14);",
			"writeFileSync(rf, JSON.stringify({ args, cwd: process.cwd() }));",
			'if (args[0] === "check") console.log(JSON.stringify({ upToDate: true }));',
		].join('\n'),
	);
	const runner = makeRunner(repoDir);
	const runDir = path.join(repoDir, 'logs', 'deploy', '20261018T120000Z');
	mkdirSync(runDir, { recursive: true });
	const logPath = path.join(runDir, 'run.log');
	const resultFile = path.join(runDir, 'result.json');
	const { pid, exited } = runner.spawnDeploy({ id: '20261018T120000Z', ack: ['db/migrations/a b.sql', '--json'], actor: 'u1', logPath, resultFile });
	assert.ok(Number.isInteger(pid));
	assert.equal(await exited, 0);
	assert.match(readFileSync(logPath, 'utf8'), /##STEP preflight/);
	const seen = JSON.parse(readFileSync(resultFile, 'utf8'));
	assert.deepEqual(seen.args.slice(0, 4), ['run', '--json', '--id=20261018T120000Z', '--actor=u1']);
	assert.ok(seen.args.includes('--ack=db/migrations/a b.sql'));
	assert.ok(seen.args.includes('--ack=--json'));
	assert.equal(path.resolve(seen.cwd), path.resolve(repoDir));
	assert.equal(runner.isAlive(pid), false);
	assert.equal(runner.isAlive(process.pid), true);

	// check goes through the same script, with a timeout
	const chk = await runner.check();
	assert.equal(chk.code, 1); // the stub's check run has no --result-file, so it throws: a failing check is reported, not hidden
});
