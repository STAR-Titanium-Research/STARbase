// The Report a bug request, as plain functions so the page and the tests share one definition.
import type { HostApi } from '@d1/ui';

export type ReportKind = 'bug' | 'feature';

export interface ReportInput {
	kind: ReportKind;
	area: string;
	scope: string;
	title: string;
	description: string;
	route: string;
	// Only when the reporter ticked "include diagnostics".
	diagnostics?: string;
	consoleTail?: string;
}

export type ReportResult = { ok: true; url: string; number: number | null } | { ok: false; reason: string };

const FALLBACK = 'The report could not be filed.';

// POST /d1-bug-report/report (core/extensions/d1-bug-report-endpoint). The endpoint answers 200 with
// {ok:false, reason} for a refusal it can explain, 401 when the session is gone; a network failure
// rejects. Every outcome comes back as a ReportResult, never a throw.
export async function submitReport(api: HostApi, input: ReportInput): Promise<ReportResult> {
	const body: Record<string, unknown> = {
		title: input.title.trim(),
		description: input.description,
		kind: input.kind,
		area: input.area,
		scope: input.scope,
		route: input.route,
	};
	if (input.diagnostics !== undefined) body.diagnostics = input.diagnostics;
	if (input.consoleTail !== undefined) body.consoleTail = input.consoleTail;
	try {
		const { data } = await api.post('/d1-bug-report/report', body);
		if (data?.ok) return { ok: true, url: String(data.url ?? ''), number: typeof data.number === 'number' ? data.number : null };
		return { ok: false, reason: data?.reason || FALLBACK };
	} catch (e: any) {
		const d = e?.response?.data;
		return { ok: false, reason: d?.error || d?.reason || d?.errors?.[0]?.message || FALLBACK };
	}
}

// Only an https GitHub-style link is offered as a link; anything else is shown as plain text.
export function issueLink(url: string): string | null {
	try {
		const u = new URL(url);
		return u.protocol === 'https:' ? u.href : null;
	} catch {
		return null;
	}
}
