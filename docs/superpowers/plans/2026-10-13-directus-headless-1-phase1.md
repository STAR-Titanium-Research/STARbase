# Directus headless, phase 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Directus modules that STARbase duplicates exactly (`d1-home`,
`d1-force-dashboard`, `d1-fast-dashboard`). Route every link Directus prints or opens through a
permanent link on the Directus host, which forwards to STARbase.

**Architecture:**
- `d1-links` gains public `GET /d1-links/go…` redirect routes that forward to `STARBASE_URL`.
- Reports, label redirects, the report-button interface, the Directus-side link resolver and the
  Force App build those permanent links instead of `/admin/home/…` paths.
- The three modules are deleted with their workspaces, CI entries, tests and docs.
- The module bar loses their tiles through a migration. A script writes the STARbase link tile with
  the absolute address.

**Tech Stack:** Directus 11.17 endpoint and interface extensions (plain JS / Vue 3); `@d1/ui`
(TypeScript, vitest); the Force App web (Vite, vitest); dbmate SQL migrations tested by
`tests/phase1_schema.sh`; Playwright UI specs.

**Spec:** `docs/superpowers/specs/2026-10-13-directus-headless-design.md` (§4, §5, §7, §8). Decision
record: `docs/adr/0015-directus-headless-starbase-is-the-only-front-end.md`.

## Global Constraints

- Nothing touches live. All work happens in the worktree `.claude/worktrees/directus-headless`
  (branch `feat/directus-headless`). The live rollout is the maintainer's (runbook, Task 9).
- Previews use only `D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057`. Never touch `d1-preview-*`
  or port 18055.
- The migration number is `20261013000171`. 165–169 are A1a's (`feat/record-access`); 170 is side-menu
  B2's.
- Pages in `packages/starbase-pages` and `packages/d1-ui` never import `@directus/extensions-sdk`.
  The `noSdkImports` and `hostNeutral` guard tests stay green.
- Permanent links:
  - `GET /d1-links/go`
  - `GET /d1-links/go/r/<collection>/<id>`
  - `GET /d1-links/go/p/<starbase path>[?query]`
  All are public, `Cache-Control: no-store`, 302 on success, 400 on a bad path, and 503 when
  `STARBASE_URL` is unset or not http(s).
- The record-page map is exactly `physical_samples→samples`, `manufacturing_operations→operations`,
  `test_sessions→tests`, `campaigns→campaigns`, `projects→projects`.
- The canonical link vocabulary inside the kit (`/home/…`, `/d1-force-dashboard`,
  `/d1-fast-dashboard`) is **kept**. Only what each host resolves it to changes.
- Push without force. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node 24, `npm ci` at the repo root.

## Review Focus

- A `p/` path carrying `..`, `%2e%2e`, `//`, a backslash or a scheme must answer 400 and never
  redirect off STARbase's origin.
- With `STARBASE_URL` unset, a QR scan must get a clear 503 text, not a redirect to a dead
  `/admin/home` page.
- The report button inside STARbase's framed editor must open a new tab, not navigate the frame.
- Kit links in Data Studio interfaces (`d1-project-items`, `d1-campaign-ops`) that used to be routes
  (`/home/…`) must open STARbase in a new tab. `host.navigate` must resolve, not push the raw path.
- After the delete, no workspace, CI step, `ci-plan` path, `plan_checks.sh` line or preview script
  may name a removed extension (`npm ci` and `ci-plan.test.mjs` prove it).

---

### Task 1: Permanent links in `d1-links`

**Files:**
- Modify: `core/extensions/d1-links/index.js`
- Modify: `core/extensions/d1-links/index.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: `RECORD_PAGES` (the exported map), `goTarget(env, kind, parts, rawQuery)` →
  `{ status, location?, text? }`, and `mount(router, env)`. `mount` registers `GET /`, `GET /go`,
  `GET /go/r/:collection/:id`, and `GET /^\/go\/p\/(.*)$/`.

- [ ] **Step 1: Write the failing tests.** Replace the `call` helper and add the tests below to
  `index.test.mjs`. Keep the existing `starbaseUrlFrom` and `GET /d1-links` tests, using the new
  `route('/')` helper in place of `call`.

```js
import { readFileSync } from 'node:fs';
import ext, { mount, starbaseUrlFrom, goTarget, RECORD_PAGES } from './index.js';

// A fake express router: collects every GET handler by its path (string or RegExp source).
function routes(env) {
	const r = {};
	mount({ get: (path, fn) => { r[path instanceof RegExp ? path.source : path] = fn; } }, env);
	return r;
}
function run(handler, req) {
	const out = { status: 200, headers: {}, body: undefined, location: undefined, type: undefined };
	const res = {
		status(c) { out.status = c; return res; },
		set(k, v) { out.headers[k] = v; return res; },
		json(b) { out.body = b; return res; },
		type(t) { out.type = t; return res; },
		send(b) { out.body = b; return res; },
		redirect(a, b) { if (b === undefined) { out.location = a; } else { out.status = a; out.location = b; } return res; },
	};
	handler({ accountability: null, params: {}, originalUrl: '/d1-links/go', query: {}, ...req }, res);
	return out;
}
const STAR = { STARBASE_URL: 'https://starbase.example.org/', PUBLIC_URL: 'https://d1.example.org' };
const P = '^\\/go\\/p\\/(.*)$';

test('RECORD_PAGES matches RECORD_PAGES in the kit (packages/d1-ui/src/recordRoute.ts)', () => {
	const src = readFileSync(new URL('../../../packages/d1-ui/src/recordRoute.ts', import.meta.url), 'utf8');
	const body = /const RECORD_PAGES[^=]*=\s*\{([^}]*)\}/.exec(src);
	assert.ok(body);
	const kit = {};
	for (const m of body[1].matchAll(/(\w+)\s*:\s*'\/home\/([^']+)'/g)) kit[m[1]] = m[2];
	assert.deepEqual(RECORD_PAGES, kit);
});

test('GET /go: STARbase Home, public, no-store', () => {
	const out = run(routes(STAR)['/go'], {});
	assert.equal(out.status, 302);
	assert.equal(out.location, 'https://starbase.example.org/');
	assert.equal(out.headers['Cache-Control'], 'no-store');
});

test('GET /go/r: a record with a STARbase page opens there, id encoded', () => {
	const h = routes(STAR)['/go/r/:collection/:id'];
	assert.equal(run(h, { params: { collection: 'physical_samples', id: 'a/b c' } }).location, 'https://starbase.example.org/samples/a%2Fb%20c');
	assert.equal(run(h, { params: { collection: 'projects', id: 'p1' } }).location, 'https://starbase.example.org/projects/p1');
});

test('GET /go/r: any other collection opens its Data Studio form on PUBLIC_URL', () => {
	const h = routes(STAR)['/go/r/:collection/:id'];
	assert.equal(run(h, { params: { collection: 'equipment', id: 'e1' } }).location, 'https://d1.example.org/admin/content/equipment/e1');
});

test('GET /go/r: a bad collection is 400', () => {
	const h = routes(STAR)['/go/r/:collection/:id'];
	for (const c of ['Physical', '1abc', 'a-b', '../x', '']) assert.equal(run(h, { params: { collection: c, id: '1' } }).status, 400, c);
});

test('GET /go/p: a STARbase page, query kept as sent', () => {
	const h = routes(STAR)[P];
	const out = run(h, { params: { 0: 'plot/force' }, originalUrl: '/d1-links/go/p/plot/force?operation=9&x=a%20b' });
	assert.equal(out.status, 302);
	assert.equal(out.location, 'https://starbase.example.org/plot/force?operation=9&x=a%20b');
	assert.equal(run(h, { params: { 0: 'labels' }, originalUrl: '/d1-links/go/p/labels' }).location, 'https://starbase.example.org/labels');
});

test('GET /go/p: never leaves STARbase (.., //, backslash, scheme, empty segment) → 400', () => {
	const h = routes(STAR)[P];
	for (const bad of ['../x', 'a/../../x', '..', '.', 'a//b', '/evil.example', 'a\\b', 'https:/x', 'javascript:alert(1)', 'a/']) {
		const out = run(h, { params: { 0: bad }, originalUrl: '/d1-links/go/p/' + bad });
		assert.equal(out.status, 400, bad);
		assert.equal(out.location, undefined, bad);
	}
});

test('STARBASE_URL unset or not http(s): every /go route answers 503 with plain text', () => {
	for (const env of [{}, { STARBASE_URL: 'javascript:alert(1)' }, { STARBASE_URL: '/x' }]) {
		const r = routes(env);
		for (const [h, req] of [[r['/go'], {}], [r['/go/r/:collection/:id'], { params: { collection: 'projects', id: '1' } }], [r[P], { params: { 0: 'labels' } }]]) {
			const out = run(h, req);
			assert.equal(out.status, 503);
			assert.equal(out.type, 'text/plain');
			assert.match(out.body, /STARbase address is not configured/);
		}
	}
});

test('goTarget never builds a location off STARbase or PUBLIC_URL', () => {
	const t = goTarget(STAR, 'p', ['plot', 'force'], '?operation=1');
	assert.equal(new URL(t.location).origin, 'https://starbase.example.org');
});
```

- [ ] **Step 2: Run them and watch them fail.**
  Run: `node --test core/extensions/d1-links/index.test.mjs`
  Expected: FAIL, because `goTarget` and `RECORD_PAGES` are not exported and the routes are missing.

- [ ] **Step 3: Implement.** In `index.js`:
  - Update the header comment to document the three new routes.
  - Add the following after `starbaseUrlFrom`.
  - Replace `mount`.

```js
// The STARbase record pages (the same map as packages/d1-ui/src/recordRoute.ts RECORD_PAGES; a test
// checks the two agree). Anything else has no STARbase page and opens its Data Studio form.
export const RECORD_PAGES = {
	physical_samples: 'samples',
	manufacturing_operations: 'operations',
	test_sessions: 'tests',
	campaigns: 'campaigns',
	projects: 'projects',
};

const COLLECTION = /^[a-z][a-z0-9_]*$/;
const UNSET = 'The STARbase address is not configured on this server (STARBASE_URL).';

// Where a permanent link goes. kind: 'home' | 'r' (parts = [collection, id]) | 'p' (parts = path
// segments, already decoded). rawQuery is '' or '?…' exactly as the caller sent it.
export function goTarget(env, kind, parts, rawQuery = '') {
	const star = starbaseUrlFrom(env);
	if (!star) return { status: 503, text: UNSET };
	if (kind === 'home') return { status: 302, location: `${star}/` };
	if (kind === 'r') {
		const [collection, id] = parts;
		if (!COLLECTION.test(String(collection ?? '')) || id === undefined || id === '') return { status: 400, text: 'Bad record link.' };
		const key = encodeURIComponent(String(id));
		const page = RECORD_PAGES[collection];
		if (page) return { status: 302, location: `${star}/${page}/${key}` };
		const base = String(env?.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
		return { status: 302, location: `${base}/admin/content/${collection}/${key}` };
	}
	// 'p': every segment must be a plain name: no empty segment (// or a trailing /), no . or .., no
	// backslash, no colon (a scheme). The result is checked to stay on STARbase's origin as well.
	if (parts.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes(':'))) {
		return { status: 400, text: 'Bad page link.' };
	}
	const location = `${star}/${parts.map(encodeURIComponent).join('/')}${rawQuery}`;
	if (new URL(location).origin !== new URL(star).origin) return { status: 400, text: 'Bad page link.' };
	return { status: 302, location };
}

function answer(res, t) {
	res.set('Cache-Control', 'no-store');
	if (t.status === 302) return res.redirect(302, t.location);
	return res.status(t.status).type('text/plain').send(t.text);
}

const rawQueryOf = (req) => {
	const u = String(req.originalUrl ?? '');
	const i = u.indexOf('?');
	return i < 0 ? '' : u.slice(i);
};

export function mount(router, env) {
	router.get('/', (req, res) => {
		if (!req.accountability?.user) return res.status(401).json({ errors: [{ message: 'Authentication required.' }] });
		res.set('Cache-Control', 'no-store');
		return res.json({ starbaseUrl: starbaseUrlFrom(env) });
	});
	// Permanent links (spec §4): public, so a phone scanning a QR code reaches STARbase's sign-in.
	// They read nothing from the database.
	router.get('/go', (_req, res) => answer(res, goTarget(env, 'home', [])));
	router.get('/go/r/:collection/:id', (req, res) => answer(res, goTarget(env, 'r', [req.params.collection, req.params.id])));
	router.get(/^\/go\/p\/(.*)$/, (req, res) => answer(res, goTarget(env, 'p', String(req.params[0] ?? '').split('/'), rawQueryOf(req))));
}
```

  Note that `'a/'.split('/')` ends in `''`, so a trailing slash is a 400 (as in the test), and
  `'/evil.example'` starts with `''`.

- [ ] **Step 4: Run the tests and watch them pass.**
  Run: `node --test core/extensions/d1-links/index.test.mjs`
  Expected: PASS, every test.

- [ ] **Step 5: Commit.**

```bash
git add core/extensions/d1-links
git commit -m "feat(d1-links): permanent links /d1-links/go (home, record, page) forwarding to STARBASE_URL"
```

---

### Task 2: `d1-report` prints permanent links

**Files:**
- Modify: `core/extensions/d1-report/src/render.js` (`adminRecordUrl` → `recordLink`; the operation
  and test renderers)
- Modify: `core/extensions/d1-report/src/index.js` (imports, the `starbaseUrl` helper, `/label`,
  `/labels`, the three report routes)
- Modify: `core/extensions/d1-report/src/index.test.mjs`
- Conditional modify: `core/extensions/d1-record-access/index.js`, only if that folder exists on
  `main` when this task runs (A1a, #259 merged first; spec §5.4a)

**Interfaces:**
- Consumes: the permanent-link URL shapes from Task 1.
- Produces: `recordLink(publicUrl, collection, id)` →
  `` `${publicUrl without trailing /}/d1-links/go/r/${collection}/${encodeURIComponent(id)}` ``.
  `EXPLORER_PAGES` stays exported (its drift test stays).

- [ ] **Step 1: Write the failing tests.** In `index.test.mjs`:
  - Import `recordLink` in place of `adminRecordUrl`.
  - Delete the tests `adminRecordUrl: …` (×4), `reports link back to the Explorer page…`, every
    `GET /label… /admin/home/labels` test, the whole `STARBASE_URL:` block and
    `with STARBASE_URL unset…`.
  - Add:

```js
const LIMS = 'https://lims.example.org';

test('recordLink: the permanent link on the Directus host, whatever the collection', () => {
	assert.equal(recordLink(LIMS, 'physical_samples', SID), `${LIMS}/d1-links/go/r/physical_samples/${SID}`);
	assert.equal(recordLink(`${LIMS}///`, 'equipment', 'a/b c'), `${LIMS}/d1-links/go/r/equipment/a%2Fb%20c`);
	assert.equal(recordLink('', 'projects', 'p1'), '/d1-links/go/r/projects/p1');
	assert.equal(recordLink(undefined, 'projects', 'p1'), '/d1-links/go/r/projects/p1');
});

test('every report links through permanent links, with no Directus Home or STARbase address in it', async () => {
	const env = { PUBLIC_URL: LIMS, STARBASE_URL: 'https://starbase.example.org' };
	const h = harness({ physical_samples: true, manufacturing_operations: true, test_sessions: true, people: true, sample_genealogy: true }, env);
	const sample = await get(h.routes, '/sample/:id', SID, user);
	assert.ok(sample.out.body.includes(`${LIMS}/d1-links/go/r/physical_samples/${SID}`), 'sample report');
	const op = await get(h.routes, '/operation/:id', OP_A, user);
	assert.ok(op.out.body.includes(`${LIMS}/d1-links/go/r/manufacturing_operations/${OP_A}`), 'operation report');
	assert.ok(op.out.body.includes(`${LIMS}/d1-links/go/r/physical_samples/${SID}`), "operation report's sample link");
	const t = await get(h.routes, '/test/:id', TEST_ID, user);
	assert.ok(t.out.body.includes(`${LIMS}/d1-links/go/r/test_sessions/${TEST_ID}`), 'test report');
	for (const body of [sample.out.body, op.out.body, t.out.body]) {
		assert.ok(!body.includes('/admin/home/'), 'a Directus Home link is left');
		assert.ok(!body.includes('starbase.example.org'), 'the front end is printed');
	}
});

test('GET /label and /labels go to the labels page through the permanent link, query kept', async () => {
	const { routes } = harness({}, { PUBLIC_URL: `${LIMS}/` });
	assert.equal((await getRedirect(routes, '/label', { ids: SID, codes: 'S 1' })).redirectTo, `${LIMS}/d1-links/go/p/labels?ids=${SID}&codes=S+1`);
	assert.equal((await getRedirect(routes, '/label', {})).redirectTo, `${LIMS}/d1-links/go/p/labels`);
	assert.equal((await getRedirect(routes, '/labels', {})).redirectTo, `${LIMS}/d1-links/go/p/labels`);
	const { routes: bare } = harness({}, {});
	assert.equal((await getRedirect(bare, '/label', { codes: 'S-001' })).redirectTo, '/d1-links/go/p/labels?codes=S-001');
});
```

- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd core/extensions/d1-report && npm ci && node --test src/index.test.mjs`
  Expected: FAIL, because `recordLink` is not exported.

- [ ] **Step 3: Implement.**
  - In `render.js`, replace the comment and `adminRecordUrl` (lines 22–34) with:

```js
// Where report QR codes and in-report links point: the permanent link on the Directus host
// (/d1-links/go/r/…, core/extensions/d1-links), which forwards to the record's STARbase page, or to its
// Data Studio form when STARbase has none. The printed address names d1-server, never the front end
// (spec 2026-10-13-directus-headless §5.1). (Labels are printed from the labels page and encode a
// self-describing QR payload, not a link.)
export function recordLink(publicUrl, collection, id) {
	const base = String(publicUrl || '').replace(/\/+$/, '');
	return `${base}/d1-links/go/r/${collection}/${encodeURIComponent(String(id))}`;
}
```

  - In `renderOperationReport` and `renderTestReport`, drop `starbaseUrl` from the destructuring
    and use `recordLink(publicUrl, 'physical_samples', o.sample_id)` (and the `t.sample_id`
    equivalent).
  - In `index.js`:
    - import `recordLink` in place of `adminRecordUrl`;
    - delete the `starbaseUrl` helper and its comment;
    - in the three report routes use `recordLink(publicUrl, '<collection>', id)` and drop the
      `starbaseUrl:` argument;
    - replace the two label routes with:

```js
		// Label routes (no authentication required) go to STARbase's labels page through the
		// permanent link, so nothing here names the front end.
		const labelsLink = () => `${String(env.PUBLIC_URL || '').replace(/\/+$/, '')}/d1-links/go/p/labels`;
		router.get('/label', (req, res) => {
			const q = new URLSearchParams();
			if (req.query.ids) q.set('ids', req.query.ids);
			if (req.query.codes) q.set('codes', req.query.codes);
			const s = q.toString();
			res.status(302).redirect(labelsLink() + (s ? `?${s}` : ''));
		});
		router.get('/labels', (_req, res) => {
			res.status(302).redirect(labelsLink());
		});
```

  - Also update the file's header comment (lines 3–5) to say the labels redirect goes through
    `/d1-links/go/p/labels`.
  - Check nothing else uses `STARBASE_URL`: `grep -n STARBASE core/extensions/d1-report/src/*.js`
    must print only test lines, or nothing.
  - **Conditional (spec §5.4a).** Check whether `core/extensions/d1-record-access/index.js`
    exists. If it does, change its `recordLink()` to return
    `` `${PUBLIC_URL without trailing /}/d1-links/go/r/${collection}/${encodeURIComponent(id)}` ``,
    and update its test in the same file's `index.test.mjs`. If it does not, write
    `Task 2: Ruling: d1-record-access not on main — left to #259 (spec §5.4a)` in the ledger.

- [ ] **Step 4: Run the tests and watch them pass.**
  Run: `cd core/extensions/d1-report && node --test src/index.test.mjs && npm run build`
  Expected: all tests PASS, and the build prints `Done`.

- [ ] **Step 5: Commit.**

```bash
git add core/extensions/d1-report
git commit -m "feat(d1-report): QR codes, in-report links and label redirects use the permanent links"
```

---

### Task 3: The Directus side of `@d1/ui` resolves to permanent links

**Files:**
- Modify: `packages/d1-ui/src/links.ts`
- Modify: `packages/d1-ui/src/links.test.ts`
- Modify: `packages/d1-ui/src/index.ts` (export list)
- Modify: `packages/directus-host/src/directusHost.ts` (`navigate`, `openDataStudio`, the comment
  on line 73)
- Modify: `packages/directus-host/src/directusHost.test.ts`

**Interfaces:**
- Consumes: the permanent-link shapes from Task 1.
- Produces:
  - `directusLinks.resolve(path)`:
    - `/home` → `{kind:'external', href:'/d1-links/go'}`;
    - `/home/<rest>` → `{kind:'external', href:'/d1-links/go/p/<rest>'}`, query kept;
    - `/d1-force-dashboard[?q]` → `{kind:'external', href:'/d1-links/go/p/plot/force[?q]'}`;
    - `/d1-fast-dashboard[?q]` → `{kind:'external', href:'/d1-links/go/p/plot/fast[?q]'}`;
    - `/d1-report/…` → external as written;
    - anything else → `{kind:'route', to: path}`.
  - The Directus host's `navigate(to)` is `openLink(to, router)`.
  - Removed exports: `starbaseUrlFor`, `starbaseUrlOnce`, `resetStarbaseUrl`. Their only caller was
    `d1-home`, which Task 6 deletes.

- [ ] **Step 1: Write the failing tests.** In `links.test.ts`:
  - Replace the `describe('the Directus host (the default)')` block's first test with the cases
    below.
  - Delete the `describe('Open in STARbase (the Directus Home module)')` block.
  - Drop `resetStarbaseUrl`, `starbaseUrlFor` and `starbaseUrlOnce` from the import.

```ts
	it('sends STARbase pages to the permanent links in a new tab, Data Studio paths stay routes', () => {
		expect(directusLinks.resolve('/home')).toEqual({ kind: 'external', href: '/d1-links/go' });
		expect(directusLinks.resolve('/home/')).toEqual({ kind: 'external', href: '/d1-links/go' });
		expect(directusLinks.resolve('/home/samples/a%2Fb?x=1')).toEqual({ kind: 'external', href: '/d1-links/go/p/samples/a%2Fb?x=1' });
		expect(directusLinks.resolve('/home?tab=2')).toEqual({ kind: 'external', href: '/d1-links/go?tab=2' });
		expect(directusLinks.resolve('/d1-force-dashboard?operation=9')).toEqual({ kind: 'external', href: '/d1-links/go/p/plot/force?operation=9' });
		expect(directusLinks.resolve('/d1-fast-dashboard')).toEqual({ kind: 'external', href: '/d1-links/go/p/plot/fast' });
		expect(directusLinks.resolve('/content/equipment/e1')).toEqual({ kind: 'route', to: '/content/equipment/e1' });
		expect(directusLinks.resolve('/homework')).toEqual({ kind: 'route', to: '/homework' });
	});
```

  - In `directusHost.test.ts`, add a test that `host.navigate('/home/samples/1')` calls
    `window.open('/d1-links/go/p/samples/1', '_blank', 'noopener')` and does not push the router.
    Also add that `host.navigate('/content/x/1')` pushes `/content/x/1`. Follow the file's existing
    mocking of `useRouter`, and spy on `window.open` with `vi.spyOn(window, 'open').mockReturnValue(null)`.

- [ ] **Step 2: Run them and watch them fail.**
  Run: `npm test -w @d1/ui -- links && npm test -w @d1/directus-host`
  Expected: FAIL, because `/home` still resolves to a route and `navigate` pushes the raw path.

- [ ] **Step 3: Implement.**
  - In `links.ts`:
    - rewrite the header comment's Directus sentence: "In Data Studio, STARbase's pages are not
      there: `/home/…` and the plot dashboards open STARbase in a new tab through the permanent
      links on this host (`/d1-links/go…`), and Data Studio paths stay routes";
    - replace `directusLinks` with the code below;
    - delete `starbaseUrlFor`, `starbaseUrlOnce`, `starbaseUrlRequest` and `resetStarbaseUrl`.

```ts
// Data Studio no longer has STARbase's pages (spec 2026-10-13-directus-headless §5.4): they open
// STARbase through the permanent links on this host, which forward to wherever STARbase lives.
function toPermanent(path: string): string | null {
	if (startsWithSegment(path, '/home')) {
		const rest = path.slice('/home'.length); // '', '/', '/samples/1?x', '?tab=2'
		if (rest === '' || rest === '/') return '/d1-links/go';
		if (rest.startsWith('?')) return '/d1-links/go' + rest;
		return '/d1-links/go/p' + rest;
	}
	for (const [from, to] of PLOTS) {
		if (startsWithSegment(path, from)) return '/d1-links/go/p' + to + path.slice(from.length);
	}
	return null;
}

export const directusLinks: LinkConfig = {
	serverBase: '',
	resolve: (path) => {
		if (REPORT.test(path)) return { kind: 'external', href: path };
		const href = toPermanent(path);
		return href ? { kind: 'external', href } : { kind: 'route', to: path };
	},
	canonical: (routePath) => routePath,
};
```

  - Move `PLOTS` and `startsWithSegment` above `directusLinks`; both are declared later in the file
    today.
  - Remove the three deleted names from `packages/d1-ui/src/index.ts`'s export line.
  - In `directusHost.ts`:
    - import `openLink` from `@d1/ui`;
    - set `navigate: (to) => openLink(to, router)` and `openDataStudio: (path) => openLink(path, router)`;
    - change the comment at the `onCreate` call to "(an app's own hook, once per signed-in user)".

- [ ] **Step 4: Run the tests and watch them pass.**
  Run: `npm test -w @d1/ui && npm run typecheck -w @d1/ui && npm test -w @d1/directus-host && npm run typecheck -w @d1/directus-host && npm test -w starbase-web`
  Expected: PASS. The STARbase tests are unchanged, because `starbaseLinks` was not touched.

- [ ] **Step 5: Commit.**

```bash
git add packages/d1-ui packages/directus-host
git commit -m "feat(ui): Data Studio opens STARbase pages through the permanent links; host.navigate resolves"
```

---

### Task 4: The report-button interface opens STARbase in a new tab

**Files:**
- Modify: `core/extensions/d1-report-button/src/interface.vue` (lines 4, 17, 41–46, 87–92)

**Interfaces:**
- Consumes: the `/d1-links/go/p/…` shape (Task 1).
- Produces: none.

- [ ] **Step 1: Implement.** This is a standalone extension with no unit-test harness; Task 8's e2e
  covers it.
  - Remove the `useRouter` import and the `router` constant.
  - Add the helper below.
  - Replace the four functions.

```js
// STARbase's pages open in a new tab through the permanent links on this host (spec §5.3). Never a
// router push: this button also runs inside STARbase's framed editor, where a push would navigate
// the frame.
function openStarbase(path) {
	window.open(`/d1-links/go/p/${path}`, '_blank', 'noopener');
}
function printLabel() {
	openStarbase(`labels?ids=${encodeURIComponent(String(props.primaryKey))}`);
}
function printLabels() {
	openStarbase('labels');
}
function openForceAnalysis() {
	openStarbase(`plot/force?operation=${encodeURIComponent(String(props.primaryKey))}`);
}
function openFastAnalysis() {
	openStarbase(`plot/fast?operation=${encodeURIComponent(String(props.primaryKey))}`);
}
```

- [ ] **Step 2: Build it.**
  Run: `cd core/extensions/d1-report-button && npm ci && npm run build`
  Expected: `Done`. Then run `grep -c "router" src/interface.vue`; expected `0`.

- [ ] **Step 3: Commit.**

```bash
git add core/extensions/d1-report-button
git commit -m "feat(report-button): labels and analyses open STARbase in a new tab via the permanent links"
```

---

### Task 5: The Force App opens records through the permanent link

**Files:**
- Create: `apps/force-app/web/src/recordLink.ts`
- Create: `apps/force-app/web/src/recordLink.test.ts`
- Modify: `apps/force-app/web/src/main.ts` (line 4 import, lines 45–48)

**Interfaces:**
- Consumes: the `/d1-links/go/r/` shape (Task 1).
- Produces: `recordLink(directusUrl: string, collection: string, id: string | number): string`.

- [ ] **Step 1: Write the failing test.** Create `recordLink.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { recordLink } from './recordLink';

describe('recordLink', () => {
	it('is the permanent link on the Directus host, id encoded, trailing slashes dropped', () => {
		expect(recordLink('https://d1.example.org/', 'physical_samples', 'a/b c')).toBe('https://d1.example.org/d1-links/go/r/physical_samples/a%2Fb%20c');
		expect(recordLink('https://d1.example.org', 'equipment', 7)).toBe('https://d1.example.org/d1-links/go/r/equipment/7');
	});
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run: `npm test -w force-app-web -- recordLink`
  Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement.** Create `recordLink.ts`:

```ts
// "Open record" goes through the permanent link on the Directus host (/d1-links/go/r/…), which
// forwards to the record's STARbase page, or its Data Studio form when STARbase has none. The Force
// App needs no STARbase setting of its own (spec 2026-10-13-directus-headless §5.2).
export function recordLink(directusUrl: string, collection: string, id: string | number): string {
	return `${directusUrl.replace(/\/+$/, '')}/d1-links/go/r/${collection}/${encodeURIComponent(String(id))}`;
}
```

  In `main.ts`:
  - replace `import { recordRoute } from '@d1/ui/recordRoute';` with
    `import { recordLink } from './recordLink';`;
  - change `openRecord`'s body to
    `window.open(recordLink(getConfig().directusUrl, collection, id), '_blank', 'noopener');`;
  - change its comment to "The record's STARbase page through the permanent link".

- [ ] **Step 4: Run the tests and watch them pass.**
  Run: `npm test -w force-app-web && npm run typecheck -w force-app-web`
  Expected: PASS.

- [ ] **Step 5: Commit.** No version bump or changelog here; the release is separate (spec §5.2).

```bash
git add apps/force-app/web/src/recordLink.ts apps/force-app/web/src/recordLink.test.ts apps/force-app/web/src/main.ts
git commit -m "feat(force-app): open record through the Directus permanent link"
```

---

### Task 6: Delete `d1-home`, `d1-force-dashboard` and `d1-fast-dashboard`

**Files:**
- Delete: `core/extensions/d1-home/`, `core/extensions/d1-force-dashboard/`,
  `core/extensions/d1-fast-dashboard/` (tracked files: `git rm -r`)
- Modify:
  - `package.json` (workspaces, `build:extension`, `build:extensions`) and `package-lock.json` (via
    `npm install`)
  - `.github/workflows/ci.yml`
  - `.github/scripts/ci-plan.mjs` and `.github/scripts/ci-plan.test.mjs`
  - `.claude/skills/ci-local/scripts/plan_checks.sh`
  - `scripts/dev/explorer_preview.sh`
- Comment-only edits that name d1-home as a host:
  - `packages/d1-ui/src/index/IndexPage.vue:5`
  - `packages/d1-ui/src/index/indexQuery.ts:94`
  - `packages/d1-ui/src/nav/ExplorerNav.vue:4`
  - any other `git grep -n "d1-home" packages apps` hit
- Delete: `tests/ui/verify_fast25.mjs`, `verify_fast25_local.mjs`, `verify_fast25_upload.mjs`,
  `verify_fast_features.mjs`, `verify_fast_recipe_panel.mjs`, `verify_force_feed_persist.mjs`,
  `verify_force_live.mjs` and `verify_force_octree.mjs`. These are one-off checks of the removed
  modules; the plot pages are covered by specs 11 and 14.

**Interfaces:**
- Consumes: Tasks 3 and 4. Nothing outside these folders still calls their code; `starbaseUrlFor`
  and `starbaseUrlOnce` are already gone.
- Produces: none.

- [ ] **Step 1: Write the failing test.** In `.github/scripts/ci-plan.test.mjs`, add:

```js
test('no job watches an extension that no longer exists', () => {
	for (const [job, paths] of Object.entries(JOBS)) {
		for (const p of paths) {
			if (p.startsWith('core/extensions/')) assert.ok(existsSync(new URL(`../../${p}`, import.meta.url)), `${job} watches missing ${p}`);
		}
	}
});
```

  Import `existsSync` from `node:fs`, and `JOBS` if the file does not already import it.

- [ ] **Step 2: Delete the three folders, then run the test and watch it fail.**
  Run: `git rm -r -q core/extensions/d1-home core/extensions/d1-force-dashboard core/extensions/d1-fast-dashboard && node --test .github/scripts/ci-plan.test.mjs`
  Expected: FAIL, naming `forceAppJs watches missing core/extensions/d1-force-dashboard/` and the
  other two.

- [ ] **Step 3: Remove every reference.**
  - `package.json`:
    - drop the three workspace entries;
    - delete the `build:extension` script;
    - `build:extensions` becomes
      `npm run build -w directus-extension-d1-edit-frame -w directus-extension-d1-lab-dashboard -w directus-extension-d1-composition-bar -w directus-extension-d1-campaign-ops -w directus-extension-d1-project-items`.
    - Then run `npm install` to rewrite `package-lock.json`.
  - `ci.yml`:
    - the force-app-js step "Build the web app (desktop base) and the Directus force dashboard"
      becomes "Build the web app (desktop base)" and runs only `npm run build:web:desktop`;
    - in directus-ui, delete the line `npm run typecheck -w directus-extension-d1-home` and rename
      the step to "Typecheck the edit frame, the lab dashboard and the campaign interface".
  - `ci-plan.mjs`: remove `'core/extensions/d1-force-dashboard/'` from `forceAppJs`, and
    `'core/extensions/d1-home/'` and `'core/extensions/d1-fast-dashboard/'` from `directusUi`.
  - `plan_checks.sh`:
    - delete the `d1-force-dashboard` line (60);
    - in the directus-ui regex, drop `d1-home|` and `|d1-fast-dashboard`;
    - in its echoed command, drop `-w directus-extension-d1-home`.
  - `explorer_preview.sh`:
    - the default `OVERLAY` becomes `d1-edit-frame d1-links d1-admin-overview`;
    - the build guard (line 52) checks `core/extensions/d1-edit-frame/dist/index.js` with the
      message `build the extensions first (npm run build:extensions)`;
    - the header comment (lines 8–12) says the same.
  - The comment-only edits above: say "the host (STARbase's ExplorerView)" instead of naming
    d1-home.
  - `git rm` the eight `tests/ui/verify_*.mjs` files listed above.
  - Run `git grep -n -E "d1-home|d1-force-dashboard|d1-fast-dashboard|directus-extension-d1-home" -- ':!docs' ':!*.md'`.
    The only hits left may be:
    - the kit's canonical paths `'/d1-force-dashboard'` and `'/d1-fast-dashboard'` (links, nav,
      process, usage and their tests, plus `LabStats.vue`);
    - the localStorage keys in the two plotting packages;
    - `scripts/*.py` comments;
    - `tests/phase1_schema.sh` and `scripts/configure_directus.sql` (Task 7).
    Fix anything else.

- [ ] **Step 4: Verify the whole JS surface.**
  Run: `npm ci && node --test .github/scripts/ci-plan.test.mjs && npm test -w @d1/ui && npm test -w @d1/starbase-pages && npm run typecheck -w @d1/starbase-pages && npm run typecheck -w directus-extension-d1-edit-frame -w directus-extension-d1-lab-dashboard -w directus-extension-d1-campaign-ops && npm run build:extensions && npm test -w starbase-web && npm run typecheck -w starbase-web && npm run build:starbase && npm run build:web:desktop`
  Expected: every command succeeds.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "chore(headless): remove d1-home, d1-force-dashboard and d1-fast-dashboard (STARbase has them)"
```

---

### Task 7: Module bar: drop the three tiles, add the STARbase link tile

**Files:**
- Create: `db/migrations/20261013000171_module_bar_drop_starbase_duplicates.sql`
- Create: `scripts/module_bar_starbase_link.sql`
- Create: `scripts/set_module_bar_starbase.sh`
- Modify: `scripts/configure_directus.sql` (lines 40–58)
- Modify: `tests/phase1_schema.sh` (a new block after the "Module bar: Home first" block)

**Interfaces:**
- Consumes: none.
- Produces:
  - Migration 171, which removes the entries whose id is `home`, `d1-force-dashboard` or
    `d1-fast-dashboard`. Its `down` puts back `home` first and the two dashboards just before
    `content` (after `d1-lab-dashboard` when present), all enabled.
  - `module_bar_starbase_link.sql`, which takes the psql variable `public_url` and puts
    `{"type":"link","id":"starbase","name":"STARbase","url":"<public_url>/d1-links/go","icon":"rocket_launch","enabled":true}`
    first, replacing any existing `starbase` entry.

- [ ] **Step 1: Write the failing schema tests.** In `tests/phase1_schema.sh`, after the
  `mb_check "null_kept:true" …` line, add:

```bash
echo "== Module bar: the STARbase duplicates leave; the STARbase link tile =="
M171=db/migrations/20261013000171_module_bar_drop_starbase_duplicates.sql
m171_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$M171")
m171_down=$(awk '/-- migrate:down/{f=1;next}f' "$M171")
link_sql=$(sed "s#:'public_url'#'https://d1.example.org/'#g" scripts/module_bar_starbase_link.sql)
m171_bar='[{"type":"module","id":"home","enabled":true},{"type":"module","id":"users","enabled":true},{"type":"module","id":"files","enabled":true},{"type":"module","id":"insights","enabled":true},{"type":"module","id":"d1-lab-dashboard","enabled":true},{"type":"module","id":"d1-force-dashboard","enabled":true},{"type":"module","id":"d1-fast-dashboard","enabled":true},{"type":"module","id":"content","enabled":true},{"type":"module","id":"settings","enabled":true}]'
m171_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_settings;
INSERT INTO directus_settings (id, module_bar) VALUES (1, '$m171_bar');
$m171_up
SELECT 'up:' || ($mb_ids);
$m171_up
SELECT 'up_again:' || ($mb_ids);
$link_sql
SELECT 'link:' || ($mb_ids);
SELECT 'link_url:' || (module_bar->0->>'url') || ',' || (module_bar->0->>'type') FROM directus_settings;
$link_sql
SELECT 'link_again:' || ($mb_ids);
$m171_down
SELECT 'down:' || ($mb_ids);
UPDATE directus_settings SET module_bar = NULL;
$m171_up
$link_sql
SELECT 'null_kept:' || (module_bar IS NULL) FROM directus_settings;
ROLLBACK;
SQL
)
m171_check() { grep -qx "$1" <<<"$m171_out" && ok "$2" || bad "$2 (psql output: $m171_out)"; }
m171_check "up:users,files,insights,d1-lab-dashboard,content,settings" "171 up: Home and the two plotters leave, the rest keeps its order"
m171_check "up_again:users,files,insights,d1-lab-dashboard,content,settings" "171 up: running it twice changes nothing"
m171_check "link:starbase,users,files,insights,d1-lab-dashboard,content,settings" "link script: the STARbase tile goes first"
m171_check "link_url:https://d1.example.org/d1-links/go,link" "link script: an absolute link to the permanent link, trailing slash dropped"
m171_check "link_again:starbase,users,files,insights,d1-lab-dashboard,content,settings" "link script: running it twice keeps one tile"
m171_check "down:home,starbase,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,content,settings" "171 down: Home first, the plotters back before the Data Studio"
m171_check "null_kept:true" "a NULL module bar is left alone by both"
```

- [ ] **Step 2: Run the test and watch it fail.**
  Run: `bash tests/phase1_schema.sh 2>&1 | grep -E "171|link script|NULL module bar is left alone by both"`.
  This needs the CI-style Postgres the script uses; see its header for `PSQL`. If the developer
  machine has no such database, run it in the `migrations` CI job instead and say so in the ledger.
  Expected: FAIL, because the files are missing.

- [ ] **Step 3: Implement.** Create the migration:

```sql
-- migrate:up
-- Directus goes headless (docs/superpowers/specs/2026-10-13-directus-headless-design.md §5.6): Home
-- and the Force and FAST plotter modules are gone (STARbase has them), so their module-bar entries
-- go too. Everything else keeps its order. The STARbase link tile needs the absolute server address,
-- which a migration cannot read, so scripts/set_module_bar_starbase.sh adds it. A NULL bar
-- (Directus' own default) is left alone. Running it twice changes nothing.
UPDATE directus_settings s
   SET module_bar = (
       SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
        WHERE COALESCE(elem->>'id', '') NOT IN ('home', 'd1-force-dashboard', 'd1-fast-dashboard')
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';

-- migrate:down
-- Put them back: Home first (after nothing), the two plotters just before the Data Studio
-- ("content"), or at the end when the bar has no content entry. Entries already present are not
-- duplicated.
UPDATE directus_settings s
   SET module_bar = (
       WITH cur AS (
           SELECT ord, elem FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
       ),
       content_at AS (SELECT min(ord) AS o FROM cur WHERE elem->>'id' = 'content'),
       placed AS (
           SELECT 0 AS pos, '{"type":"module","id":"home","enabled":true}'::jsonb AS elem
            WHERE NOT EXISTS (SELECT 1 FROM cur WHERE elem->>'id' = 'home')
           UNION ALL
           SELECT ord * 10, elem FROM cur
           UNION ALL
           SELECT COALESCE((SELECT o FROM content_at) * 10 - 2, 100000), '{"type":"module","id":"d1-force-dashboard","enabled":true}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM cur WHERE elem->>'id' = 'd1-force-dashboard')
           UNION ALL
           SELECT COALESCE((SELECT o FROM content_at) * 10 - 1, 100001), '{"type":"module","id":"d1-fast-dashboard","enabled":true}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM cur WHERE elem->>'id' = 'd1-fast-dashboard')
       )
       SELECT jsonb_agg(elem ORDER BY pos) FROM placed
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';
```

  The `down` test expects `home,starbase,…`: home goes in front of whatever is first, including the
  link tile. The link tile is not removed by `down`; it belongs to the script.

  Create `scripts/module_bar_starbase_link.sql`:

```sql
-- The module bar's STARbase tile (docs/superpowers/specs/2026-10-13-directus-headless-design.md §5.6).
-- Directus turns a link url that starts with "/" into a route inside /admin (module-bar.vue), so the
-- tile needs the absolute server address: pass it as the psql variable public_url
-- (scripts/set_module_bar_starbase.sh does). The tile goes first, replacing any earlier starbase
-- entry; a NULL bar is left alone. Running it twice changes nothing.
UPDATE directus_settings s
   SET module_bar = (
       SELECT jsonb_build_array(jsonb_build_object(
                  'type', 'link', 'id', 'starbase', 'name', 'STARbase',
                  'url', regexp_replace(:'public_url', '/+$', '') || '/d1-links/go',
                  'icon', 'rocket_launch', 'enabled', true))
              || COALESCE((SELECT jsonb_agg(elem ORDER BY ord)
                             FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
                            WHERE COALESCE(elem->>'id', '') <> 'starbase'), '[]'::jsonb)
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';
```

  Create `scripts/set_module_bar_starbase.sh` and make it executable:
  `git update-index --chmod=+x scripts/set_module_bar_starbase.sh`.

```bash
#!/usr/bin/env bash
# Put the STARbase link tile first in Directus's module bar (spec 2026-10-13-directus-headless §5.6).
# Reads DIRECTUS_PUBLIC_URL from .env (or the first argument) and runs scripts/module_bar_starbase_link.sql
# in the compose postgres. Idempotent. The maintainer runs it on live after migration 171; it is not
# part of configure_all.sh, which must never run on live.
#   bash scripts/set_module_bar_starbase.sh [https://d1-server.tail54eeb6.ts.net]
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:-}"
if [[ -z "$url" && -f .env ]]; then url=$(grep -E '^DIRECTUS_PUBLIC_URL=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r'); fi
[[ "$url" =~ ^https?://[^/]+ ]] || { echo "Need an absolute http(s) DIRECTUS_PUBLIC_URL (got: '${url}')" >&2; exit 1; }
DB_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- | tr -d '\r' || true)
DB_NAME=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- | tr -d '\r' || true)
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -v public_url="$url" \
	-U "${DB_USER:-d1}" -d "${DB_NAME:-d1_database}" < scripts/module_bar_starbase_link.sql
echo "Module bar: STARbase tile -> ${url%/}/d1-links/go"
```

  `.env.example` names them `POSTGRES_USER` (default `d1`) and `POSTGRES_DB` (default `d1_database`),
  the same defaults `configure_all.sh` uses.

  In `scripts/configure_directus.sql`, edit the bar seed:
  - remove the `home`, `d1-force-dashboard` and `d1-fast-dashboard` lines;
  - change the condition `OR module_bar::text NOT LIKE '%d1-lab-dashboard%'` to
    `OR module_bar::text LIKE '%"home"%'`, so an old seeded bar is rewritten once and a curated one
    is not;
  - rewrite the comment above to say Home and the plotters are STARbase pages now (spec §5.6) and
    that the STARbase tile is added by `scripts/set_module_bar_starbase.sh`;
  - fix the `-- "Samples" is the view the d1-home module links to` comment (line ~235) to say
    STARbase's sidebar.

- [ ] **Step 4: Run the tests and watch them pass.**
  Run the same command as Step 2. Expected: all 7 new checks `ok`, and the existing module-bar
  checks still `ok`.

- [ ] **Step 5: Commit.**

```bash
git add db/migrations/20261013000171_module_bar_drop_starbase_duplicates.sql scripts/module_bar_starbase_link.sql scripts/set_module_bar_starbase.sh scripts/configure_directus.sql tests/phase1_schema.sh
git commit -m "feat(db): module bar drops Home and the plotters (migration 171); script adds the STARbase link tile"
```

---

### Task 8: UI specs follow STARbase

**Files:**
- Modify: `tests/ui/specs/11-force-dashboard.spec.ts`
- Modify: `tests/ui/specs/13-explorer-routes.spec.ts`
- Modify: `tests/ui/specs/14-starbase.spec.ts` (add one test)

**Interfaces:**
- Consumes:
  - `tests/ui/starbase/target.ts`: `signInStarbase(page, who, origins?)`, `STAR_BASE`, `D1_BASE`,
    `adminApi`, `firstId`.
  - Tasks 1, 4 and 7.
- Produces: none.

- [ ] **Step 1: Spec 11 → STARbase `/plot/force`.**
  - Import `signInStarbase` and `STAR_BASE` from `'../starbase/target'` and `test`/`expect` from
    `@playwright/test`. Spec 14 does the same; copy its `test.use`/`beforeEach` pattern for sign-in.
  - Replace every `page.goto('/admin/d1-force-dashboard…')` with
    `page.goto(\`${STAR_BASE}/plot/force…\`)` (the same query).
  - Call `await signInStarbase(page, 'admin')` first in each test.
  - Update the header comment to "STARbase's Force plotter page".
  - The selectors stay, because it is the same `ForceDashboard` component.

- [ ] **Step 2: Spec 13 → STARbase only for the pages.**
  - Make `STARBASE` default to `STAR_BASE` from `target.ts` when `D1_ROUTES_STARBASE` is unset:
    `const STARBASE = (process.env.D1_ROUTES_STARBASE || STAR_BASE).replace(/\/+$/, '');`.
  - `appUrl` always uses STARbase.
  - `signIn(page, who)` always uses `signInStarbase`.
  - Rename the old Directus sign-in to `signInDirectus(page, who)` (the body that was under the
    `if`).
  - In `'the other kit users still render'`, remove the `test.skip(!!STARBASE, …)` line and call
    `signInDirectus` instead of `signIn`.
  - Update the header comment: "Every STARbase page … The other kit users (the campaign form, the
    lab dashboard) are Data Studio pages and are checked on Directus."

- [ ] **Step 3: Spec 14: the permanent links and the module bar.** Add:

```ts
test('permanent links on d1-server forward to STARbase; the module bar has the STARbase tile', async ({ page, request }) => {
	const r = await request.get(`${D1_BASE}/d1-links/go/p/plot/force?operation=1`, { maxRedirects: 0 });
	expect(r.status()).toBe(302);
	expect(r.headers()['location']).toBe(`${STAR_BASE}/plot/force?operation=1`);
	const bad = await request.get(`${D1_BASE}/d1-links/go/p/a//b`, { maxRedirects: 0 });
	expect(bad.status()).toBe(400);
});
```

  The preview's `STARBASE_URL` comes from `tests/ui/starbase/preview-ports.env` (`http://127.0.0.1:5190`,
  = `STAR_BASE` in ports mode) and `preview-hosts.env`, passed with `D1_PREVIEW_ENV_FILE`. Run the
  link script against the preview's database:

```bash
docker exec -i d1-starbase-postgres psql -X -v ON_ERROR_STOP=1 -v public_url=http://127.0.0.1:18057 -U d1 -d d1_database < scripts/module_bar_starbase_link.sql
```

  Use the container name, user and db the preview script uses (`docker ps --format '{{.Names}}' | grep d1-starbase`).

- [ ] **Step 4: Run the UI specs on the preview.**

```bash
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env bash scripts/dev/explorer_preview.sh
```
```bash
cd tests/ui && npx playwright test specs/11-force-dashboard.spec.ts specs/13-explorer-routes.spec.ts specs/14-starbase.spec.ts specs/15-starbase-polish.spec.ts
```

  Expected:
  - specs 13, 14 and 15 PASS;
  - spec 11 PASS if the preview has a processed force analysis, otherwise its existing
    "requires data" skip;
  - also open Data Studio on the preview and check that the report button on an operation opens a
    new tab at `/d1-links/go/p/plot/force?operation=…` (Review Focus 3). Note the result in the
    ledger.

- [ ] **Step 5: Commit.**

```bash
git add tests/ui
git commit -m "test(headless): plot spec and route harness run on STARbase; permanent-link e2e"
```

---

### Task 9: Docs and the phase-1 runbook

**Files:**
- Modify:
  - `docs/runbooks/starbase.md`: a new section "Phase 1 of going headless (2026-10-13)". Also fix
    the intro "runs beside the Directus Home module" and drop step 9 of the smoke check ("Open in
    STARbase").
  - `docs/wiki/database/{administration,developer-guide,explorer-pages,samples}.md`
  - `docs/wiki/force-app/developer-guide.md`
  - `docs/runbooks/physical-test-backlog.md`
  - `core/README.md`
- Modify: `docs/superpowers/specs/2026-10-13-directus-headless-design.md` §7 phase-1 steps, so they
  match the runbook exactly.

**Interfaces:** none.

- [ ] **Step 1: Write the runbook section.** Every step is the maintainer's, approved on its own:

```markdown
## Phase 1 of going headless (spec 2026-10-13-directus-headless)

Directus loses Home and the two plotter modules; everything Directus prints or opens goes through the
permanent links (`/d1-links/go…`). **Directus mounts `core/extensions` as it is**, and `git pull`
leaves a removed extension's ignored `dist/` and `node_modules/` behind, where Directus keeps
loading them, so step 2 deletes them by hand.

1. `git pull && npm ci && npm run build:starbase && npm run build:extensions`, then
   `(cd core/extensions/d1-report && npm ci && npm run build)` and
   `(cd core/extensions/d1-report-button && npm ci && npm run build)`.
2. Delete what is left of the three removed extensions, then check:
   `rm -rf core/extensions/d1-home core/extensions/d1-force-dashboard core/extensions/d1-fast-dashboard`
   (PowerShell: `Remove-Item -Recurse -Force core/extensions/d1-home, core/extensions/d1-force-dashboard, core/extensions/d1-fast-dashboard`).
3. `dbmate up` (migration 171), then `bash scripts/set_module_bar_starbase.sh`.
4. `docker compose up -d --force-recreate directus`, then
   `docker compose exec directus ls /directus/extensions`: the three names are gone.
5. Smoke:
   - `curl -sI https://d1-server.tail54eeb6.ts.net/d1-links/go/r/physical_samples/<id>` → `302`
     to `https://starbase.tail54eeb6.ts.net/samples/<id>`;
   - `curl -sI "https://d1-server.tail54eeb6.ts.net/d1-links/go/p/a//b"` → `400`;
   - in Data Studio, the module bar's first tile is STARbase and opens it; Home and the Force/FAST
     tiles are gone;
   - a sample report's QR code opens the sample in STARbase;
   - on an operation's Data Studio form, "View Force Analysis" opens STARbase's plot in a new tab;
   - a project's items list links open STARbase.
6. Force App: ship the release that contains "open record through the permanent link".

Rollback: `git checkout <previous commit>`, rebuild as in step 1, `dbmate rollback`, then recreate
`directus`. The STARbase tile stays first in the bar; remove it under Settings → Appearance if
wanted.
```

- [ ] **Step 2: Update the other docs.**
  - Replace `/admin/home/<page>` links with STARbase addresses (`https://starbase.tail54eeb6.ts.net/<page>`).
  - Replace mentions of the Home module, the "Force dashboard module" and the "FAST dashboard module"
    as places to go with STARbase and its Force/FAST plotter pages.
  - Keep historical notes (changelogs, dated plan and spec files) as they are.
  - Check: `git grep -n -E "admin/home|d1-home|Home module" -- docs/wiki docs/runbooks core/README.md`
    leaves only lines that describe history or the removal itself.

- [ ] **Step 3: Commit.**

```bash
git add docs core/README.md
git commit -m "docs(headless): phase-1 runbook; wiki and runbooks point at STARbase"
```

---

## Self-review notes (writer)

- **Spec coverage:**
  - §4 → Task 1.
  - §5.1 → Task 2, which also covers §5.4a conditionally.
  - §5.2 → Task 5.
  - §5.3 → Task 4.
  - §5.4 → Task 3.
  - §5.5 → Task 6.
  - §5.6 → Task 7.
  - §5.7 → Tasks 8 and 9.
  - §7 phase 1 → Task 9.
  - §8 S1 and S4 were answered in the spec; S2 and S3 are phase 2.
- **Not in phase 1:** the lab dashboard, crawler and Ask modules and their tiles (phase 2).
  `d1-lab-dashboard` stays in the bar seed and the workspaces.
