import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { D1_LOCAL, STAR_BASE, account, adminApi, pointAtD1 } from '../starbase/target';

// My teams (People 4: `GET /d1-teams/:id/records` and `GET /d1-teams/mine/recent` in d1-teams, the Team filter of the index kit and of the
// Projects page, the Home "My teams" panel), in a real browser against the d1-starbase preview, ports layout, same setup as spec 14
// (tests/ui/README.md). The preview overlay needs d1-teams, d1-record-access, d1-people-admin, d1-person-link, d1-owner-default and
// d1-access-guard (migrations 177 and 178 are on the preview copy). Run: npx playwright test specs/20-my-teams.spec.ts
//
// What it proves on real Directus and Postgres (the unit tests use fakes): Ruling M1, the Team filter and the panel only ever name records the
// viewer can read. A restricted sample shared with the team BEFORE the viewer joined is pending for the viewer (not readable), yet it is one of
// the team's records: it must never show in the viewer's filtered Samples list, in the panel, or in the ids the endpoint returns; a stranger who
// filters by the team sees nothing. Also: `f.team=<id>` round-trips through the URL and a reload; the Projects page says "Loading this team's
// projects…" while the ids load and never flashes "No project matches"; the Home panel appears for a member with recent team records, draws
// nothing (not even its heading) for a person in no team, "Show N more" moves keyboard focus to the first revealed line (line 11), and a record
// link is named "<Kind> <code>: <title>".
//
// Cast, all made by the tests and removed in `afterAll`: the preview Lab Member ("Preview Member", M) creates the team and is its manager; OWNER
// owns a restricted sample (HIDDEN) shared with the team and a project (PI) shared with the team; JOINER is a plain member who joined after HIDDEN
// was shared (so it is pending on it); STRANGER is in no team. The team owns 12 restricted samples (more than the panel's first 10 lines).
test.use({ trace: 'off' });
test.describe.configure({ mode: 'serial' });

const D1 = D1_LOCAL;
const TEAMS = `${D1}/d1-teams`;
const ACCESS = `${D1}/d1-record-access`;
const TEAM_SAMPLES = 12;
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
type Pw = PlaywrightWorkerArgs['playwright'];

interface Login { userId: string; personId: string; email: string; password: string; name: string }

async function labMemberRole(api: APIRequestContext): Promise<string> {
	const roles = ((await (await api.get(`${D1}/roles?fields=id,name&limit=-1`)).json()).data ?? []) as { id: string; name: string }[];
	const id = roles.find((r) => r.name === 'Lab Member')?.id;
	expect(id, 'the Lab Member role').toBeTruthy();
	return id!;
}

// A Lab Member login with a password; d1-person-link makes its person (found by polling). The ids go into `created` as soon as they exist, so a
// failure later still cleans them up.
async function makeLogin(api: APIRequestContext, label: string, created: { users: string[]; people: string[] }): Promise<Login> {
	const tag = unique();
	const email = `e2e-mt-${label.toLowerCase()}-${tag}@example.com`;
	const password = `E2e-${tag}-Passw0rd!`;
	const made = await api.post(`${D1}/users`, { data: { email, password, status: 'active', role: await labMemberRole(api), first_name: `E2E${label}`, last_name: tag } });
	expect(made.ok(), `create the ${label} login: ${made.status()}`).toBeTruthy();
	const userId = (await made.json()).data.id as string;
	created.users.push(userId);
	let person: { person_id: string; full_name: string } | undefined;
	await expect.poll(async () => {
		const r = await api.get(`${D1}/items/people?filter[user_id][_eq]=${userId}&fields=person_id,full_name`);
		person = ((await r.json()).data as { person_id: string; full_name: string }[])[0];
		return !!person;
	}, { message: `the person of the ${label} login` }).toBe(true);
	created.people.push(person!.person_id);
	return { userId, personId: person!.person_id, email, password, name: person!.full_name };
}

async function apiAs(pw: Pw, email: string, password: string): Promise<APIRequestContext> {
	const anon = await pw.request.newContext();
	const login = await anon.post(`${D1}/auth/login`, { data: { email, password, mode: 'json' } });
	expect(login.ok(), `API login of ${email}`).toBeTruthy();
	const token = (await login.json()).data.access_token as string;
	await anon.dispose();
	return pw.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

// A signed-in STARbase page of one login in its own browser context.
async function pageAs(browser: Browser, email: string, password: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext();
	await pointAtD1(context);
	const page = await context.newPage();
	await page.goto(`${STAR_BASE}/signin`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /^sign in$/i }).click();
	await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
	return { context, page };
}

// What Directus 11 answers a reader the item filter hides from: 403 (not 404, so existence does not leak).
const DENIED = 403;
const sampleStatus = async (api: APIRequestContext, id: string) => (await api.get(`${D1}/items/physical_samples/${id}?fields=sample_id`)).status();

interface Cast {
	admin: APIRequestContext;
	m: APIRequestContext;
	owner: Login;
	joiner: Login;
	joinerApi: APIRequestContext;
	stranger: Login;
	teamId: string;
	teamName: string;
	/** the team's samples the joiner can read, by code (nickname "e2e nick NN") */
	teamCodes: string[];
	hiddenCode: string;
	hiddenId: string;
	projectName: string;
	cleanup: () => Promise<void>;
}

let c: Cast;

async function cast(pw: Pw): Promise<Cast> {
	const admin = await adminApi(pw);
	const [memberEmail, memberPassword] = account('member');
	const m = await apiAs(pw, memberEmail, memberPassword);
	const created: { users: string[]; people: string[] } = { users: [], people: [] };
	const track: { teams: string[]; records: { collection: string; id: string }[] } = { teams: [], records: [] };
	const apis: APIRequestContext[] = [];
	// Every step runs in its own try and its status is checked (Playwright does not throw on 4xx): 2xx and 404 (already gone) are fine,
	// anything else is logged and fails the run at the end, after the remaining steps have run. The team-owned records go before the teams.
	const cleanup = async () => {
		const failed: string[] = [];
		const step = async (what: string, run: () => Promise<{ status(): number; text(): Promise<string> } | void>) => {
			try {
				const r = await run();
				if (r && !(r.status() >= 200 && r.status() < 300) && r.status() !== 404) failed.push(`${what}: ${r.status()} ${(await r.text()).slice(0, 200)}`);
			} catch (e) {
				failed.push(`${what}: ${String(e)}`);
			}
		};
		for (const r of track.records) await step(`delete ${r.collection} ${r.id}`, () => admin.delete(`${D1}/items/${r.collection}/${r.id}`));
		for (const id of track.teams) await step(`delete team ${id}`, () => admin.delete(`${TEAMS}/${id}`));
		for (const id of created.people) await step(`delete person ${id}`, () => admin.delete(`${D1}/items/people/${id}`));
		// a person made by d1-person-link after the poll gave up is found by its user
		for (const id of created.users) {
			await step(`delete the person of user ${id}`, async () => {
				const found = ((await (await admin.get(`${D1}/items/people?filter[user_id][_eq]=${id}&fields=person_id`)).json()).data ?? []) as { person_id: string }[];
				for (const p of found) await admin.delete(`${D1}/items/people/${p.person_id}`);
			});
			await step(`delete user ${id}`, () => admin.delete(`${D1}/users/${id}`));
		}
		for (const a of apis) await step('dispose an API context', () => a.dispose());
		await step('dispose the manager API context', () => m.dispose());
		await step('dispose the admin API context', () => admin.dispose());
		if (failed.length) {
			console.error(['E2E cleanup left something behind:', ...failed].join('\n'));
			throw new Error(`E2E cleanup failed in ${failed.length} step(s): ${failed.join(' | ')}`);
		}
	};
	try {
		const owner = await makeLogin(admin, 'Owner', created);
		const joiner = await makeLogin(admin, 'Joiner', created);
		const stranger = await makeLogin(admin, 'Stranger', created);
		const ownerApi = await apiAs(pw, owner.email, owner.password);
		const joinerApi = await apiAs(pw, joiner.email, joiner.password);
		apis.push(ownerApi, joinerApi);

		const tag = unique();
		const teamName = `E2E My Team ${tag}`;
		const made = await m.post(TEAMS, { data: { name: teamName } });
		expect(made.status(), 'the member creates a team').toBe(201);
		const teamId = (await made.json()).team_id as string;
		track.teams.push(teamId);

		// HIDDEN: OWNER's restricted sample, shared with the team BEFORE the joiner joins, so the joiner is pending on it (no trust for future members).
		const hiddenCode = `E2E-MT-${tag}-HIDDEN`;
		const hidden = await admin.post(`${D1}/items/physical_samples?fields=sample_id`, {
			data: { sample_code: hiddenCode, nickname: 'e2e hidden', item_type: 'sample', current_status: 'active', owner_person_id: owner.personId, restricted: true },
		});
		expect(hidden.ok(), `create the hidden sample: ${hidden.status()} ${await hidden.text()}`).toBeTruthy();
		const hiddenId = (await hidden.json()).data.sample_id as string;
		track.records.push({ collection: 'physical_samples', id: hiddenId });
		const shared = await ownerApi.post(`${ACCESS}/physical_samples/${hiddenId}/entries`, { data: { team_id: teamId, role: 'edit' } });
		expect(shared.ok(), `the owner shares HIDDEN with the team: ${shared.status()} ${await shared.text()}`).toBeTruthy();

		const added = await m.post(`${TEAMS}/${teamId}/members`, { data: { person_id: joiner.personId, is_manager: false } });
		expect(added.status(), 'the manager adds the joiner').toBe(201);
		expect(await sampleStatus(joinerApi, hiddenId), 'the joiner is pending on HIDDEN, so cannot read it').toBe(DENIED);

		// The team's own samples (owner_team_id), more than the panel's first ten lines; the joiner is an active member, so reads them.
		const teamCodes: string[] = [];
		for (let i = 1; i <= TEAM_SAMPLES; i++) {
			const nn = String(i).padStart(2, '0');
			const code = `E2E-MT-${tag}-${nn}`;
			const r = await admin.post(`${D1}/items/physical_samples?fields=sample_id`, {
				data: { sample_code: code, nickname: `e2e nick ${nn}`, item_type: 'sample', current_status: 'active', owner_team_id: teamId, restricted: true },
			});
			expect(r.ok(), `create team sample ${nn}: ${r.status()} ${await r.text()}`).toBeTruthy();
			track.records.push({ collection: 'physical_samples', id: (await r.json()).data.sample_id as string });
			teamCodes.push(code);
		}

		// A project the team has a grant on (a project is never owned by a team): OWNER is its PI and shares it (Can view) with the team.
		const projectName = `E2E My Team Project ${tag}`;
		const p = await admin.post(`${D1}/items/projects?fields=project_id`, {
			data: { project_code: `E2E-MT-${tag}`, project_name: projectName, principal_investigator_person: owner.personId },
		});
		expect(p.ok(), `create the project: ${p.status()} ${await p.text()}`).toBeTruthy();
		const projectId = (await p.json()).data.project_id as string;
		track.records.push({ collection: 'projects', id: projectId });
		const pshared = await ownerApi.post(`${ACCESS}/projects/${projectId}/entries`, { data: { team_id: teamId, role: 'view' } });
		expect(pshared.ok(), `the PI shares the project with the team: ${pshared.status()} ${await pshared.text()}`).toBeTruthy();

		return { admin, m, owner, joiner, joinerApi, stranger, teamId, teamName, teamCodes, hiddenCode, hiddenId, projectName, cleanup };
	} catch (e) {
		// the original failure is the one to report; cleanup logs its own problems
		await cleanup().catch(() => undefined);
		throw e;
	}
}

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(180_000);
	c = await cast(playwright);
	// the team's samples are readable to the joiner (the derived rows may take a moment)
	await expect.poll(async () => (await c.joinerApi.get(`${D1}/items/physical_samples?filter[sample_code][_starts_with]=E2E-MT-&limit=-1&fields=sample_code`).then((r) => r.json())).data.length, { message: 'the joiner reads the team samples' }).toBe(TEAM_SAMPLES);
});

test.afterAll(async () => {
	await c?.cleanup();
});

test('the endpoints only name records the viewer can read (Ruling M1)', async ({ playwright }) => {
	// The team's records for the joiner: the 12 team samples, not HIDDEN (shared with the team but pending for the joiner).
	const j = await c.joinerApi.get(`${TEAMS}/${c.teamId}/records?collection=physical_samples`);
	expect(j.status()).toBe(200);
	const body = (await j.json()) as { ids: string[]; truncated: boolean };
	expect(body.ids.length, 'the joiner is told of the 12 readable team samples').toBe(TEAM_SAMPLES);
	expect(body.ids, 'not HIDDEN').not.toContain(c.hiddenId);
	expect(body.truncated).toBe(false);
	// The manager (active on HIDDEN through the share) is told of 13.
	const mb = (await (await c.m.get(`${TEAMS}/${c.teamId}/records?collection=physical_samples`)).json()) as { ids: string[] };
	expect(mb.ids, 'the manager reads HIDDEN through the share, so it is listed for them').toContain(c.hiddenId);
	expect(mb.ids.length).toBe(TEAM_SAMPLES + 1);
	// A stranger is told of nothing.
	const sApi = await apiAs(playwright, c.stranger.email, c.stranger.password);
	try {
		const sb = (await (await sApi.get(`${TEAMS}/${c.teamId}/records?collection=physical_samples`)).json()) as { ids: string[] };
		expect(sb.ids, 'a stranger reads none of the team records').toEqual([]);
		const mine = (await (await sApi.get(`${TEAMS}/mine/recent`)).json()) as { items: unknown[] };
		expect(mine.items, 'a person in no team has no recent team records').toEqual([]);
	} finally {
		await sApi.dispose();
	}
	// mine/recent for the joiner: readable team records only (the 12 samples and the shared project), never HIDDEN.
	const recent = (await (await c.joinerApi.get(`${TEAMS}/mine/recent?limit=20`)).json()) as { items: { id: string; code: string }[] };
	expect(recent.items.length, 'the 12 samples and the project').toBe(TEAM_SAMPLES + 1);
	expect(recent.items.map((i) => i.id)).not.toContain(c.hiddenId);
});

test('the Samples Team filter shows the team records the member can read, never the one they cannot; f.team round-trips', async ({ browser }) => {
	const j = await pageAs(browser, c.joiner.email, c.joiner.password);
	try {
		const page = j.page;
		const rows = page.locator('tbody tr.row');
		await page.goto(`${STAR_BASE}/home/samples`);
		await expect(page.getByLabel('Filter by team')).toBeVisible();
		await expect(rows.first()).toBeVisible();
		// choose the team in the select: the URL carries f.team and the list narrows to the team's readable samples
		await page.getByLabel('Filter by team').selectOption({ label: c.teamName });
		await expect.poll(() => new URL(page.url()).searchParams.get('f.team')).toBe(c.teamId);
		await expect(rows).toHaveCount(TEAM_SAMPLES);
		for (const code of c.teamCodes) await expect(page.getByRole('link', { name: code, exact: true })).toBeVisible();
		await expect(page.getByText(c.hiddenCode), 'HIDDEN (pending for this member) never appears').toHaveCount(0);

		// the URL round-trips: a reload and a fresh visit to the same URL both keep the filter
		await page.reload();
		await expect(page.getByLabel('Filter by team')).toHaveValue(c.teamId);
		await expect(rows).toHaveCount(TEAM_SAMPLES);
		await page.goto(`${STAR_BASE}/home/samples?f.team=${c.teamId}`);
		await expect(page.getByLabel('Filter by team')).toHaveValue(c.teamId);
		await expect(rows).toHaveCount(TEAM_SAMPLES);
		await expect(page.getByText(c.hiddenCode)).toHaveCount(0);

		// clearing the chip returns to the unfiltered list
		await page.getByLabel('Filter by team').selectOption('');
		await expect.poll(() => new URL(page.url()).searchParams.has('f.team')).toBe(false);
	} finally {
		await j.context.close();
	}
	// A stranger who filters by the team (the URL is shareable) sees nothing: the filter never widens to unreadable records.
	const s = await pageAs(browser, c.stranger.email, c.stranger.password);
	try {
		await s.page.goto(`${STAR_BASE}/home/samples?f.team=${c.teamId}`);
		await expect(s.page.getByText('Nothing matches.')).toBeVisible();
		await expect(s.page.locator('tbody tr.row')).toHaveCount(0);
		await expect(s.page.getByText(c.hiddenCode)).toHaveCount(0);
	} finally {
		await s.context.close();
	}
});

test('the Projects Team filter says it is loading, then shows the project, with no "No project matches" flash', async ({ browser }) => {
	const j = await pageAs(browser, c.joiner.email, c.joiner.password);
	try {
		const page = j.page;
		// a record of every change of the page's text that says "No project matches", from the first paint on
		await j.context.addInitScript(() => {
			(window as unknown as { __flash: boolean }).__flash = false;
			new MutationObserver(() => {
				if (document.body && (document.body.textContent ?? '').includes('No project matches')) (window as unknown as { __flash: boolean }).__flash = true;
			}).observe(document, { subtree: true, childList: true, characterData: true });
		});
		// the team's ids come slowly, so the loading state can be seen
		await page.route('**/d1-teams/*/records*', async (route) => {
			await new Promise((r) => setTimeout(r, 2000));
			await route.continue();
		});
		await page.goto(`${STAR_BASE}/home/projects?f.team=${c.teamId}`);
		await expect(page.getByText("Loading this team's projects…")).toBeVisible();
		await expect(page.getByText('No project matches')).toHaveCount(0);
		await expect(page.getByText(c.projectName)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Loading this team's projects…")).toHaveCount(0);
		expect(await page.evaluate(() => (window as unknown as { __flash: boolean }).__flash), '"No project matches" never flashed').toBe(false);
		await expect(page.getByLabel('Filter by team')).toHaveValue(c.teamId);
	} finally {
		await j.context.close();
	}
});

test('Home: My teams lists the team records with accessible links; Show more moves focus to line 11; a person in no team sees nothing', async ({ browser }) => {
	const j = await pageAs(browser, c.joiner.email, c.joiner.password);
	try {
		const page = j.page;
		const recent = page.waitForResponse((r) => r.url().includes('/d1-teams/mine/recent') && r.ok());
		await page.goto(`${STAR_BASE}/home`);
		const items = ((await (await recent).json()) as { items: { id: string }[] }).items;
		const total = Math.min(items.length, 20);
		expect(total, 'the panel needs more than ten lines for Show more').toBeGreaterThan(10);

		await expect(page.getByRole('heading', { name: 'My teams' })).toBeVisible();
		const lines = page.locator('ul.lines > li');
		await expect(lines).toHaveCount(10);
		// every record link is named "<Kind> <code>: <title>"
		const names = await lines.locator('a[aria-label]').evaluateAll((as) => as.map((a) => a.getAttribute('aria-label') ?? ''));
		expect(names.length).toBe(10);
		for (const n of names) expect(n).toMatch(/^(Sample|Project) \S.*/);
		expect(names.some((n) => /^Sample E2E-MT-\S+-\d\d: e2e nick \d\d$/.test(n)), `a sample link is named kind, code and title: ${names.join(' | ')}`).toBe(true);
		await expect(page.getByRole('link', { name: /^Sample E2E-MT-\S+-\d\d: e2e nick \d\d$/ }).first()).toBeVisible();
		await expect(page.getByText(c.hiddenCode), 'HIDDEN is not on the panel').toHaveCount(0);

		// "Show N more" by keyboard: the button goes away and focus lands on line 11 (the first revealed one), not on <body>
		const more = page.getByRole('button', { name: `Show ${total - 10} more` });
		await more.focus();
		await page.keyboard.press('Enter');
		await expect(lines).toHaveCount(total);
		await expect(more).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => {
			const li = document.querySelectorAll('ul.lines > li')[10];
			return !!li && li.contains(document.activeElement);
		}), { message: 'focus is inside line 11' }).toBe(true);
		await expect(page.getByText(c.hiddenCode)).toHaveCount(0);
	} finally {
		await j.context.close();
	}

	// A person in no team: the panel draws nothing, not even its heading.
	const s = await pageAs(browser, c.stranger.email, c.stranger.password);
	try {
		const answered = s.page.waitForResponse((r) => r.url().includes('/d1-teams/mine/recent'));
		await s.page.goto(`${STAR_BASE}/home`);
		expect((await answered).ok(), 'the endpoint answered').toBe(true);
		await s.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200))));
		await expect(s.page.getByRole('heading', { name: 'My teams' })).toHaveCount(0);
		await expect(s.page.locator('ul.lines')).toHaveCount(0);
		await expect(s.page.getByText('All teams →')).toHaveCount(0);
	} finally {
		await s.context.close();
	}
});
