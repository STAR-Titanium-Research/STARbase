// Directus endpoint: d1-ask  (mounted at /d1-ask)
//
// Server-side proxy between the "Ask the Database" module (browser) and the
// guarded text-to-SQL plugin (llm-text-to-sql on the internal d1net). It exists
// so that:
//   1. the browser never learns WORKER_WEBHOOK_SECRET (injected here, server-side),
//   2. the plugin need not be exposed to the host — only Directus calls it,
//   3. access is gated: only admins and users with app access may ask. The
//      plugin reads the database through a role that bypasses Directus row and
//      field permissions, so API-only tokens (e.g. Rig_1) and anonymous
//      requests are refused before any LLM/DB work happens.
//
// The plugin still applies its own SQL guard + read-only role (ADR-0009); this
// endpoint adds the authentication boundary, it does not replace the guard.

const PLUGIN_URL = (env) =>
    (env.LLM_PLUGIN_URL || 'http://llm-text-to-sql:8080').replace(/\/+$/, '');

export const MAX_MESSAGES = 20;
export const MAX_CONTENT_CHARS = 4000;
export const UPSTREAM_TIMEOUT_MS = 60_000;
export const UPSTREAM_AUTH_ERROR =
    "text-to-SQL service rejected the server's credentials (misconfigured secret)";
const ALLOWED_ROLES = new Set(['user', 'assistant']);

// Validate the client body and rebuild it: only `messages` is ever forwarded
// (no client-chosen row_limit or other fields), at most MAX_MESSAGES long. Returns { messages } or { error }.
export function sanitiseMessages(body) {
    const raw = body && body.messages;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: 'messages must be a non-empty array' };
    }
    // The chat page sends the whole conversation, so a long session would exceed the
    // cap: keep only the most recent messages rather than failing the request.
    const recent = raw.length > MAX_MESSAGES ? raw.slice(-MAX_MESSAGES) : raw;
    const messages = [];
    for (const m of recent) {
        if (!m || typeof m !== 'object' || !ALLOWED_ROLES.has(m.role)) {
            return { error: 'each message needs role "user" or "assistant"' };
        }
        if (typeof m.content !== 'string') {
            return { error: 'each message needs string content' };
        }
        if (m.content.length > MAX_CONTENT_CHARS) {
            return {
                error: `message content is limited to ${MAX_CONTENT_CHARS} characters`,
            };
        }
        messages.push({ role: m.role, content: m.content });
    }
    return { messages };
}

export default {
    id: 'd1-ask',
    handler: (router, { env, logger }) => {
        // POST /d1-ask/chat  →  plugin POST /api/chat
        // Body: { messages: [{role, content}...] }
        router.post('/chat', async (req, res) => {
            const acc = req.accountability;
            if (!acc?.user) {
                return res.status(401).json({ error: 'authentication required' });
            }
            if (acc.admin !== true && acc.app !== true) {
                return res.status(403).json({ error: 'forbidden' });
            }

            const secret = env.WORKER_WEBHOOK_SECRET || '';
            if (!secret) {
                logger.error('d1-ask: WORKER_WEBHOOK_SECRET is not set');
                return res.status(503).json({ error: 'text-to-SQL not configured' });
            }

            const { messages, error } = sanitiseMessages(req.body);
            if (error) {
                return res.status(400).json({ error });
            }

            try {
                const upstream = await fetch(`${PLUGIN_URL(env)}/api/chat`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Worker-Secret': secret,
                    },
                    body: JSON.stringify({ messages }),
                    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
                });

                // The plugin answering 401/403 means the server's own WORKER_WEBHOOK_SECRET was
                // refused: that is a deployment fault, not the signed-in user's, so do not relay
                // it as 401/403 (the UI would tell the user to sign in again).
                if (upstream.status === 401 || upstream.status === 403) {
                    logger.error(
                        `d1-ask: text-to-SQL service answered ${upstream.status}; ` +
                            'check that WORKER_WEBHOOK_SECRET matches the plugin',
                    );
                    return res.status(502).json({
                        error: UPSTREAM_AUTH_ERROR,
                        code: 'upstream_auth',
                    });
                }

                // Relay the plugin's status and JSON verbatim (including its 422
                // "generated SQL rejected" responses, so the UI can explain them).
                const text = await upstream.text();
                res.status(upstream.status);
                res.set('Content-Type', 'application/json');
                return res.send(text || '{}');
            } catch (err) {
                if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                    logger.error('d1-ask proxy timed out');
                    return res
                        .status(504)
                        .json({ error: 'text-to-SQL service timed out' });
                }
                logger.error(`d1-ask proxy failed: ${err.message}`);
                return res
                    .status(502)
                    .json({ error: 'text-to-SQL service unavailable' });
            }
        });
    },
};
