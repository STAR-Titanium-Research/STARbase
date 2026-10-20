// node --test infra/deploy-agent/*.test.mjs
// run-agent.ps1 (the Scheduled Task's wrapper) against a stub agent. Skipped where no PowerShell is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./run-agent.ps1', import.meta.url));
const shell = ['powershell.exe', 'pwsh'].find((c) => spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0);

/** A repo dir (with a space in its name) whose agent.mjs exits with the given codes, one per start. */
function stubRepo(codes) {
	const dir = mkdtempSync(path.join(tmpdir(), 'run agent '));
	mkdirSync(path.join(dir, 'infra', 'deploy-agent'), { recursive: true });
	writeFileSync(
		path.join(dir, 'infra', 'deploy-agent', 'agent.mjs'),
		[
			"import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
			"const f = new URL('./n.txt', import.meta.url);",
			"const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;",
			'writeFileSync(f, String(n + 1));',
			`const codes = ${JSON.stringify(codes)};`,
			'process.exit(codes[n] ?? 0);',
		].join('\n'),
	);
	return dir;
}

function run(codes, extra) {
	const dir = stubRepo(codes);
	try {
		const r = spawnSync(
			shell,
			['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-RepoDir', dir, '-NodePath', process.execPath, ...extra],
			{ encoding: 'utf8', timeout: 60_000 },
		);
		return { code: r.status, out: r.stdout };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('run-agent.ps1: exit 75 restarts at once, every other exit restarts with a doubling backoff', { skip: !shell }, () => {
	const r = run([75, 3, 3, 3, 3], ['-InitialDelaySeconds', '0.2', '-MaxDelaySeconds', '0.4', '-ResetAfterSeconds', '300', '-MaxRestarts', '5']);
	assert.equal(r.code, 3);
	const lines = r.out.split(/\r?\n/).filter(Boolean);
	assert.match(lines[0], /exited 75.*restarting now/);
	assert.match(lines[1], /exited 3 .*restarting in 0\.2 s/);
	assert.match(lines[2], /exited 3 .*restarting in 0\.4 s/);
	assert.match(lines[3], /exited 3 .*restarting in 0\.4 s/, 'capped at the maximum');
});

test('run-agent.ps1: the backoff resets once an instance stayed up long enough', { skip: !shell }, () => {
	const r = run([3, 3, 3, 3], ['-InitialDelaySeconds', '0.2', '-MaxDelaySeconds', '5', '-ResetAfterSeconds', '0', '-MaxRestarts', '4']);
	const waits = [...r.out.matchAll(/restarting in ([\d.]+) s/g)].map((m) => m[1]);
	assert.deepEqual(waits, ['0.2', '0.2', '0.2']);
});

test('run-agent.ps1: a clean exit is restarted too (the agent is meant to run forever)', { skip: !shell }, () => {
	const r = run([0, 0], ['-InitialDelaySeconds', '0.1', '-MaxRestarts', '2']);
	assert.equal(r.code, 0);
	assert.match(r.out, /exited 0 .*restarting in 0\.1 s/);
});
