// Directus endpoint: d1-deploy  (mounted at /d1-deploy)
//
// Admin-only proxy between the "Deploy" module (browser) and the host-side deploy
// agent (infra/deploy-agent, Scheduled Task on d1-server). The agent runs git, npm
// builds and `docker compose` on the host; Directus only relays. It exists so that:
//   1. the browser never learns DEPLOY_AGENT_TOKEN (injected here, server-side),
//   2. only an admin can check or deploy (the real gate; the module hides itself too),
//   3. the actor recorded for a run is the signed-in user, not a client-chosen value.
//
// Routes map 1:1 to the agent: GET /state, POST /check, POST /deploy, GET /runs,
// GET /runs/:id?offset=N. Docs: docs/superpowers/specs/2026-10-18-deploy-button-design.md

const AGENT_URL = (env) =>
    (env.DEPLOY_AGENT_URL || 'http://host.docker.internal:8212').replace(/\/+$/, '');

export const RUN_ID_RE = /^\d{8}T\d{6}Z$/;
export const MAX_ACK = 50;
export const MAX_ACK_CHARS = 300;
// `POST /check` runs git fetch + docker compose config on the host (agent limit 90 s).
export const CHECK_TIMEOUT_MS = 100_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const AGENT_AUTH_ERROR =
    "deploy agent rejected the server's token (DEPLOY_AGENT_TOKEN does not match)";

// Validate the client body and rebuild it: only `ack` is ever forwarded.
// Returns { ack } (array, possibly empty) or { error }.
export function sanitiseAck(body) {
    const raw = body && typeof body === 'object' ? body.ack : undefined;
    if (raw === undefined || raw === null) return { ack: [] };
    if (!Array.isArray(raw)) return { error: 'ack must be an array of file names' };
    if (raw.length > MAX_ACK) return { error: `ack is limited to ${MAX_ACK} entries` };
    for (const a of raw) {
        if (typeof a !== 'string' || a.length === 0 || a.length > MAX_ACK_CHARS) {
            return {
                error: `each ack entry must be a string of 1 to ${MAX_ACK_CHARS} characters`,
            };
        }
    }
    return { ack: [...raw] };
}

// Returns { offset } (non-negative integer, default 0) or { error }.
export function parseOffset(value) {
    if (value === undefined || value === '') return { offset: 0 };
    if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) {
        return { error: 'offset must be a non-negative integer' };
    }
    return { offset: Number(value) };
}

export default {
    id: 'd1-deploy',
    handler: (router, { env, logger }) => {
        // Gate + token check shared by every route; returns the actor id or null
        // (after sending the response).
        const gate = (req, res) => {
            const acc = req.accountability;
            if (!acc?.user) {
                res.status(401).json({ error: 'authentication required' });
                return null;
            }
            if (acc.admin !== true) {
                res.status(403).json({ error: 'forbidden' });
                return null;
            }
            if (!env.DEPLOY_AGENT_TOKEN) {
                logger.error('d1-deploy: DEPLOY_AGENT_TOKEN is not set');
                res.status(503).json({
                    error: 'deploy agent not configured',
                    code: 'not_configured',
                });
                return null;
            }
            return String(acc.user);
        };

        const relay = async (res, actor, method, path, { body, timeout } = {}) => {
            try {
                const headers = {
                    'X-Deploy-Token': env.DEPLOY_AGENT_TOKEN,
                    'X-Deploy-Actor': actor,
                };
                if (body !== undefined) headers['Content-Type'] = 'application/json';
                const upstream = await fetch(`${AGENT_URL(env)}${path}`, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.timeout(timeout ?? DEFAULT_TIMEOUT_MS),
                });
                // The agent refusing the token is a deployment fault, not the signed-in
                // user's: relaying 401/403 would make the Directus app think the session
                // expired, so report it as a 502.
                if (upstream.status === 401 || upstream.status === 403) {
                    logger.error(
                        `d1-deploy: agent answered ${upstream.status}; ` +
                            'check that DEPLOY_AGENT_TOKEN matches the agent',
                    );
                    return res
                        .status(502)
                        .json({ error: AGENT_AUTH_ERROR, code: 'agent_auth' });
                }
                const text = await upstream.text();
                res.status(upstream.status);
                res.set('Content-Type', 'application/json');
                return res.send(text || '{}');
            } catch (err) {
                logger.error(`d1-deploy: agent unreachable: ${err.message}`);
                return res.status(502).json({
                    error: 'deploy agent unreachable',
                    code: 'agent_unreachable',
                });
            }
        };

        router.get('/state', (req, res) => {
            const actor = gate(req, res);
            if (actor) return relay(res, actor, 'GET', '/state');
        });

        router.post('/check', (req, res) => {
            const actor = gate(req, res);
            if (actor) {
                return relay(res, actor, 'POST', '/check', { timeout: CHECK_TIMEOUT_MS });
            }
        });

        router.post('/deploy', (req, res) => {
            const actor = gate(req, res);
            if (!actor) return;
            const { ack, error } = sanitiseAck(req.body);
            if (error) return res.status(400).json({ error });
            return relay(res, actor, 'POST', '/deploy', { body: { ack } });
        });

        router.get('/runs', (req, res) => {
            const actor = gate(req, res);
            if (actor) return relay(res, actor, 'GET', '/runs');
        });

        router.get('/runs/:id', (req, res) => {
            const actor = gate(req, res);
            if (!actor) return;
            const id = req.params?.id;
            if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
                return res.status(400).json({ error: 'invalid run id' });
            }
            const { offset, error } = parseOffset(req.query?.offset);
            if (error) return res.status(400).json({ error });
            return relay(res, actor, 'GET', `/runs/${id}?offset=${offset}`);
        });
    },
};
