// Shapes returned by the d1-deploy endpoint (which relays the host-side agent).
// Contract: docs/superpowers/specs/2026-10-18-deploy-button-design.md

export interface CheckCommit {
	sha: string;
	subject: string;
}

export interface CheckMigration {
	file: string;
	destructive: string[];
}

export interface CheckBlocker {
	code: string;
	message: string;
}

export interface CheckResult {
	upToDate: boolean;
	branch: string;
	head: string;
	target: string;
	commits: CheckCommit[];
	changedCount: number;
	steps: string[];
	migrations: CheckMigration[];
	dirty: string[];
	overlap: string[];
	conflicts: string[] | null;
	blockers: CheckBlocker[];
	needsAck: string[];
}

export interface RunStep {
	name: string;
	ok: boolean;
	ms: number;
	skipped?: boolean;
}

export interface RunResult {
	id: string;
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	actor: string | null;
	branch: string | null;
	fromSha: string | null;
	toSha: string | null;
	steps: RunStep[];
	backup: string | null;
	failedStep: string | null;
	message: string;
}

/** One entry of `GET /runs` and `state.last`; the spec does not pin more than this, so the rest is optional. */
export type RunSummary = Partial<RunResult> & { id: string; ok: boolean };

export interface AgentState {
	running: boolean;
	current: { id: string; startedAt: string; actor: string | null; step: string | null } | null;
	last: RunSummary | null;
	repo: { branch: string; head: string; dirty: string[] };
}

export interface RunPoll {
	id: string;
	done: boolean;
	result: RunResult | null;
	log: string;
	nextOffset: number;
}

export interface ApiProblem {
	status: number | null;
	code: string | null;
	message: string;
}
