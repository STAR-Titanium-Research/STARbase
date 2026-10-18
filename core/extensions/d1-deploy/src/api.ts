import type { ApiProblem } from './types';

/** Turn an axios error from `useApi()` into the endpoint's message, code and HTTP status. */
export function describeError(e: unknown): ApiProblem {
	const err = e as { response?: { status?: number; data?: { error?: string; code?: string; errors?: { message?: string; extensions?: { code?: string } }[] } }; message?: string };
	const data = err?.response?.data;
	return {
		status: err?.response?.status ?? null,
		code: data?.code ?? data?.errors?.[0]?.extensions?.code ?? null,
		message: data?.error ?? data?.errors?.[0]?.message ?? err?.message ?? 'Request failed',
	};
}

/** One-line fix hints for the two setup problems an admin can fix themselves. */
export function hintFor(code: string | null): string | null {
	switch (code) {
		case 'not_configured':
			return 'Set DEPLOY_AGENT_TOKEN (and DEPLOY_AGENT_URL if the agent is not on the default) in .env, make sure the directus service passes them through, then recreate Directus. See docs/runbooks/deploy-button.md.';
		case 'agent_unreachable':
			return 'The deploy agent is not answering. On d1-server, check that the Scheduled Task "D1 Deploy Agent" is running (infra/deploy-agent/install.ps1) and that DEPLOY_AGENT_URL points at it.';
		case 'agent_auth':
			return 'The agent rejected the token: DEPLOY_AGENT_TOKEN in Directus must equal the one the agent was started with.';
		default:
			return null;
	}
}

export function shortSha(sha: string | null | undefined): string {
	return sha ? sha.slice(0, 8) : '';
}

/** Parse a run id (`YYYYMMDDTHHMMSSZ`) or ISO string into a local date-time string. */
export function formatTime(value: string | null | undefined): string {
	if (!value) return '';
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
	const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(value);
	return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Step names in the order a run printed them (`##STEP <name>` lines). */
export function stepsInLog(log: string): string[] {
	const out: string[] = [];
	for (const m of log.matchAll(/^##STEP (\S+)/gm)) out.push(m[1]!);
	return out;
}
