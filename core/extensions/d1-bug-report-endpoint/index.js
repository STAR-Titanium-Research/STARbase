// Directus endpoint: d1-bug-report  (mounted at /d1-bug-report)
//
// Server-side bridge between STARbase's "Report a bug" page (browser) and the bug-report relay
// (apps/force-app/bug-report-relay), which holds the GitHub App key and files the issue. It exists
// so that:
//   1. no GitHub credential ever reaches the browser (the relay holds it, not Directus),
//   2. the reporter's identity comes from the authenticated session, not from anything the client
//      claims: a "Reported by" line a user could forge is worse than none,
//   3. only logged-in users can file, since the relay itself has no auth.
//
// Contract mirrors the relay's: failures come back as {ok: false, reason} with a 200 so the UI can
// render `reason` directly; only a missing login is a real 401.

const RELAY_URL = (env) =>
    (env.BUG_REPORT_RELAY_URL || 'http://bug-report-relay:8211').replace(/\/+$/, '');

const KINDS = {
    bug: { label: 'bug', prefix: '[Bug]' },
    feature: { label: 'enhancement', prefix: '[Feature]' },
};

// Fixed set (not whatever string a client sends), so the area line in the body is always one of these.
// Keep AREAS and PAGES in sync with the page's src/bugReport/scopes.ts.
const AREAS = new Set(['data-entry', 'dashboards', 'reports', 'access', 'general']);

// Secondary choice within an area. Data entry is a collection (dynamic, so shape-checked rather than
// listed); every other area has a fixed set of pages.
const PAGES = {
    dashboards: ['home', 'force-plot', 'fast-plot', 'force-crawler'],
    reports: ['sample-overview', 'operation-report', 'test-report', 'print-labels'],
    access: ['login', 'permissions', 'account'],
};
const COLLECTION_KEY = /^[a-z][a-z0-9_]{0,62}$/i;

// The scope text for a valid scope, else null: an unrecognised scope is dropped. It only ever goes
// into the body, never into a label, so a reporter cannot mint labels in the issue tracker.
function resolveScope(area, scope) {
    const s = String(scope ?? '');
    if (area === 'data-entry') return COLLECTION_KEY.test(s) ? s : null;
    return PAGES[area]?.includes(s) ? s : null;
}

// Reporter-side diagnostics are untrusted free text bound for a public-ish issue body, so strip
// obvious credentials and make them fence-safe (a literal ``` would close our block early).
const SECRET_PATTERNS = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
    [/\b(access_token|refresh_token|token|password|secret|api_key)=[^&\s]+/gi, '$1=<redacted>'],
];
const redact = (text) => SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);

const fence = (text, limit) => [
    '```',
    redact(String(text).trim().slice(-limit)).replace(/```/g, '`​`​`'),
    '```',
];

// `starbase-report` and `area:starbase` say where it came from. Not `in-app-report`: that label feeds
// the Force App's "already reported" list. The picked area and page go in the body, not a label,
// so a reporter cannot mint labels in the issue tracker.
const BASE_LABELS = ['starbase-report'];

// A literal backtick in the route would close the code span and let the rest render as markdown.
const safeRoute = (route) =>
    String(route || 'unknown').slice(0, 300).replace(/`/g, "'");

export function buildIssue({
    title,
    description,
    kind,
    area,
    scope,
    route,
    reporterEmail,
    role,
    diagnostics = '',
    consoleTail = '',
}) {
    let t = String(title ?? '').trim();
    if (!t) return { error: 'A title is required.' };
    const k = KINDS[kind] ? kind : 'bug';
    const a = AREAS.has(area) ? area : 'general';
    // Tag by prefix from the picker, not by trusting a "[Bug]" the reporter typed themselves.
    if (!t.startsWith(KINDS[k].prefix)) t = `${KINDS[k].prefix} ${t}`;

    const reporter = reporterEmail
        ? `${reporterEmail}${role ? ` (${role})` : ''}`
        : '_unknown_';
    const resolved = resolveScope(a, scope);
    const parts = [
        String(description ?? '').trim().slice(0, 20000) || '_(no description provided)_',
        '',
        '---',
        `**Area:** ${a}${resolved ? ` › ${resolved}` : ''}  `,
        `**Reported by:** ${reporter}  `,
        `**Route at time of report:** \`${safeRoute(route)}\`  `,
        '**Source:** STARbase  ',
    ];
    // Browser state first: short, and answers "what browser/size/locale" without a round-trip.
    // The console tail is collapsed so it does not bury the description. Limits leave headroom
    // under GitHub's 65536-char body cap for both together.
    if (String(diagnostics).trim()) {
        parts.push('', '**Browser state at time of report**', '', ...fence(diagnostics, 3000));
    }
    if (String(consoleTail).trim()) {
        parts.push(
            '',
            '<details><summary>Browser console (auto-attached)</summary>',
            '',
            ...fence(consoleTail, 16000),
            '</details>',
        );
    }

    return {
        title: t.slice(0, 250),
        body: parts.join('\n'),
        labels: [...BASE_LABELS, KINDS[k].label, 'area:starbase'],
    };
}

async function lookupReporter(database, userId) {
    try {
        const row = await database('directus_users as u')
            .leftJoin('directus_roles as r', 'r.id', 'u.role')
            .where('u.id', userId)
            .first('u.email', 'r.name as role');
        return { email: row?.email ?? '', role: row?.role ?? '' };
    } catch {
        return { email: '', role: '' };
    }
}

async function callRelay(url, init) {
    try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
        if (!res.ok) return { ok: false, reason: `bug-report relay error (HTTP ${res.status})` };
        return await res.json();
    } catch (err) {
        return { ok: false, reason: `could not reach the bug-report relay: ${err.message}` };
    }
}

export default {
    id: 'd1-bug-report',
    handler: (router, { env, database, logger }) => {
        // POST /d1-bug-report/report  → relay POST /report
        // Body: { title, description, kind, area, scope, route, diagnostics, consoleTail }
        router.post('/report', async (req, res) => {
            const userId = req.accountability?.user;
            if (!userId) return res.status(401).json({ error: 'authentication required' });

            const { email, role } = await lookupReporter(database, userId);
            const issue = buildIssue({
                ...(req.body ?? {}),
                reporterEmail: email,
                role,
            });
            if (issue.error) return res.json({ ok: false, reason: issue.error });

            const out = await callRelay(`${RELAY_URL(env)}/report`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(issue),
            });
            if (!out.ok) logger.error(`d1-bug-report relay failed: ${out.reason}`);
            return res.json(out);
        });
    },
};
