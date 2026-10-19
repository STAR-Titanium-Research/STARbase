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

export interface CheckHolder {
	pid: number;
	name: string;
	cmd: string;
	reason: string;
}

/** An earlier deploy that merged but did not finish its install/build/restart steps. */
export interface CheckResume {
	runId: string | null;
	fromSha: string;
	failedStep: string | null;
	message: string;
}

/** The pseudo-acknowledgement for "stop the processes in `holders` before npm install". */
export const STOP_HOLDERS_ACK = 'stop-node-modules-holders';

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
	/** Processes holding files in node_modules (absent from older agents). */
	holders?: CheckHolder[];
	/** Set when this check finishes an earlier, unfinished deploy (absent from older agents). */
	resume?: CheckResume | null;
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
