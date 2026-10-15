import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { D1_LOCAL, STAR_BASE, account, adminApi, pointAtD1 } from '../starbase/target';

// Team ownership (People 3: migrations 183 and 184, the owner grant and the `manage` level, the guards, `d1-record-access` transfer to a
// team, the `d1-teams` delete guard, STARbase's Who has access with a team owner, the rails and the team page), in a real browser against
// the d1-starbase preview, ports layout, same setup as spec 14 (tests/ui/README.md). The preview overlay needs d1-teams,
// d1-record-access, d1-people-admin, d1-person-link, d1-owner-default and d1-access-guard (the migrations 183 and 184 are on the preview
// copy). Run: npx playwright test specs/19-team-ownership.spec.ts
//
// What it proves on real Directus and Postgres (the unit tests use fakes): the person and role conditions of the Lab Member delete and
// manage rules bind to the SAME access row, so a plain member of the owning team (an `edit` row) is refused delete, share and transfer
// although a manager's `manage` row exists on the same record; demoting a manager removes that at once (Ruling O1); a Lab Member cannot
// create a record with owner_team_id (Ruling O3); a transfer to a team with no manager is refused (Ruling O4); a team that owns records
// cannot be deleted; transfer back to a person clears the team; a team-owned orphan operation is not open to everybody.
//
// Cast, all made by the tests and removed in `finally`: the preview Lab Member ("Preview Member", M) creates the teams and is their
// manager; OWNER owns a Restricted sample; JOINER (a plain team member) and STRANGER (in no team) are further Lab Members with a person
// each (d1-person-link makes the person). The preview has no mail transport, so mails are not asserted (the unit tests cover them).
test.use({ trace: 'off' });

const D1 = D1_LOCAL;
const TEAMS = `${D1}/d1-teams`;
const ACCESS = `${D1}/d1-record-access`;
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
type Pw = PlaywrightWorkerArgs['playwright'];

interface Login { userId: string; personId: string; email: string; password: string; name: string }

async function labMemberRole(api: APIRequestContext): Promise<string> {
	const roles = ((await (await api.get(`${D1}/roles?fields=id,name&limit=-1`)).json()).data ?? []) as { id: string; name: string }[];
	const id = roles.find((r) => r.name === 'Lab Member')?.id;
	expect(id, 'the Lab Member role').toBeTruthy();
	return id!;
}

// A Lab Member login with a password; d1-person-link makes its person (found by polling).
// The ids go into `created` as soon as they exist, so a failure later in this function (or the cast) still cleans them up.
async function makeLogin(api: APIRequestContext, label: string, created: { users: string[]; people: string[] }): Promise<Login> {
	const tag = unique();
	const email = `e2e-own-${label.toLowerCase()}-${tag}@example.com`;
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

// What Directus 11 answers a reader the item filter hides from, and a writer it refuses: 403 (not 404, so existence does not leak).
const DENIED = 403;

// The cast: M's API session (the team's manager), OWNER and its API session, JOINER (a plain member of the team) and STRANGER (in no team),
// a team M manages with JOINER in it, and a Restricted sample OWNER owns. cleanup() removes it all, whatever state a test left it in
// (the team-owned records go before the teams: a team that owns a record cannot be deleted).
interface Cast {
	admin: APIRequestContext;
	m: APIRequestContext;
	owner: Login;
	ownerApi: APIRequestContext;
	joiner: Login;
	joinerApi: APIRequestContext;
	stranger: Login;
	strangerApi: APIRequestContext;
	teamId: string;
	teamName: string;
	sampleId: string;
	sampleCode: string;
	track: { teams: string[]; records: { collection: string; id: string }[] };
	cleanup: () => Promise<void>;
}

async function cast(pw: Pw): Promise<Cast> {
	const admin = await adminApi(pw);
	const [memberEmail, memberPassword] = account('member');
	const m = await apiAs(pw, memberEmail, memberPassword);
	const created: { users: string[]; people: string[] } = { users: [], people: [] };
	const track: Cast['track'] = { teams: [], records: [] };
	const apis: APIRequestContext[] = [];
	// Every step runs in its own try and its status is checked (Playwright does not throw on 4xx): 2xx and 404 (already gone) are fine,
	// anything else is logged and fails the test at the end, after the remaining steps have run.
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
		const strangerApi = await apiAs(pw, stranger.email, stranger.password);
		apis.push(ownerApi, joinerApi, strangerApi);

		const teamName = `E2E Owners ${unique()}`;
		const made = await m.post(TEAMS, { data: { name: teamName } });
		expect(made.status(), 'the member creates a team').toBe(201);
		const teamId = (await made.json()).team_id as string;
		track.teams.push(teamId);
		const added = await m.post(`${TEAMS}/${teamId}/members`, { data: { person_id: joiner.personId, is_manager: false } });
		expect(added.status(), 'the manager adds a plain member').toBe(201);

		const sampleCode = `E2E-O-${unique()}`;
		const s = await admin.post(`${D1}/items/physical_samples?fields=sample_id`, {
			data: { sample_code: sampleCode, item_type: 'sample', current_status: 'active', owner_person_id: owner.personId, restricted: true },
		});
		expect(s.ok(), `create the sample: ${s.status()} ${await s.text()}`).toBeTruthy();
		const sampleId = (await s.json()).data.sample_id as string;
		track.records.push({ collection: 'physical_samples', id: sampleId });
		return { admin, m, owner, ownerApi, joiner, joinerApi, stranger, strangerApi, teamId, teamName, sampleId, sampleCode, track, cleanup };
	} catch (e) {
		// the original failure is the one to report; cleanup logs its own problems
		await cleanup().catch(() => undefined);
		throw e;
	}
}

const readStatus = async (api: APIRequestContext, sampleId: string) => (await api.get(`${D1}/items/physical_samples/${sampleId}?fields=sample_id,notes`)).status();
const editStatus = async (api: APIRequestContext, sampleId: string) => (await api.patch(`${D1}/items/physical_samples/${sampleId}`, { data: { notes: `e2e ${unique()}` } })).status();
const deleteStatus = async (api: APIRequestContext, sampleId: string) => (await api.delete(`${D1}/items/physical_samples/${sampleId}`)).status();
const samplePage = (c: Cast) => `${STAR_BASE}/samples/${encodeURIComponent(c.sampleId)}`;
const dialogOf = (page: Page) => page.getByRole('dialog', { name: /who has access/i });
const listOf = async (api: APIRequestContext, sampleId: string) => (await api.get(`${ACCESS}/physical_samples/${sampleId}`)).json();
const personEntry = (api: APIRequestContext, sampleId: string, personId: string, role: 'view' | 'edit') =>
	api.post(`${ACCESS}/physical_samples/${sampleId}/entries`, { data: { person_id: personId, role } });
const transfer = (api: APIRequestContext, sampleId: string, to: { team_id: string } | { person_id: string }) =>
	api.post(`${ACCESS}/physical_samples/${sampleId}/transfer`, { data: to });
const errorCode = async (r: { json(): Promise<unknown> }) => ((await r.json()) as { errors?: { extensions?: { code?: string } }[] }).errors?.[0]?.extensions?.code;

// The owner gives the sample to the team in the browser: Who has access -> Transfer ownership… -> pick the team -> Confirm transfer.
async function transferToTeamInBrowser(page: Page, c: Cast): Promise<void> {
	await page.goto(samplePage(c));
	await page.getByRole('button', { name: 'Who has access' }).click();
	const dialog = dialogOf(page);
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Transfer ownership…' }).click();
	await dialog.getByRole('combobox', { name: 'New owner, by name' }).fill(c.teamName);
	await dialog.getByRole('option', { name: new RegExp(c.teamName) }).click();
	await expect(dialog.getByRole('status').filter({ hasText: 'becomes the owner' })).toContainText(`Only ${c.teamName}'s managers can change who has access.`);
	await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
}

test('a transfer to a team: managers share and delete, a plain member edits but cannot manage, a stranger sees nothing, the rail shows the team', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	const ctxs: BrowserContext[] = [];
	try {
		expect(await readStatus(c.m, c.sampleId), 'before the transfer the manager cannot read the Restricted sample').toBe(DENIED);
		expect(await readStatus(c.joinerApi, c.sampleId), 'nor can the plain member').toBe(DENIED);

		// The owner transfers the sample to the team in the browser; the dialog now shows the team as the owner.
		const o = await pageAs(browser, c.owner.email, c.owner.password);
		ctxs.push(o.context);
		await transferToTeamInBrowser(o.page, c);
		const ownerRow = dialogOf(o.page).locator('li.row.owner');
		await expect(ownerRow).toHaveAttribute('data-owner-kind', 'team');
		await expect(ownerRow).toContainText(`${c.teamName} (managers)`);
		await expect(ownerRow).toContainText('Managers: Preview Member');
		await expect(dialogOf(o.page).getByRole('alert')).toHaveCount(0);

		// The record now belongs to the team: the owner grant is hidden (Ruling O2), the previous owner stays as Can edit (person -> team).
		const list = await listOf(c.admin, c.sampleId);
		expect(list.owner.kind).toBe('team');
		expect(list.owner.team_id).toBe(c.teamId);
		expect((list.teams as { team_id: string }[]).some((t) => t.team_id === c.teamId), 'the owner grant is not a team entry').toBe(false);
		expect(await readStatus(c.ownerApi, c.sampleId), 'the previous owner stays on the record').toBe(200);
		expect(await editStatus(c.ownerApi, c.sampleId), 'as Can edit').toBe(200);

		// M (the manager) and JOINER (a plain member) both read and edit; the stranger reads nothing.
		await expect.poll(() => readStatus(c.m, c.sampleId), { message: 'the manager reads' }).toBe(200);
		expect(await editStatus(c.m, c.sampleId), 'the manager edits').toBe(200);
		expect(await readStatus(c.joinerApi, c.sampleId), 'the plain member reads').toBe(200);
		expect(await editStatus(c.joinerApi, c.sampleId), 'the plain member edits (Can edit)').toBe(200);
		expect(await readStatus(c.strangerApi, c.sampleId), 'a stranger is still refused').toBe(DENIED);

		// THE binding check: a manager's `manage` row exists on this record, yet the plain member's `edit` row does not make the member a
		// manager. Delete (Directus rule), sharing, transfer and the owner fields (d1-access-guard) are all refused to the plain member.
		const jl = await listOf(c.joinerApi, c.sampleId);
		expect(jl.can_manage, 'the plain member may not manage').toBe(false);
		expect((await personEntry(c.joinerApi, c.sampleId, c.stranger.personId, 'view')).status(), 'the plain member cannot share').toBe(DENIED);
		expect((await transfer(c.joinerApi, c.sampleId, { person_id: c.joiner.personId })).status(), 'nor transfer').toBe(DENIED);
		expect(await deleteStatus(c.joinerApi, c.sampleId), 'nor delete').toBe(DENIED);
		expect((await c.joinerApi.patch(`${D1}/items/physical_samples/${c.sampleId}`, { data: { owner_team_id: null } })).status(), 'nor clear the owner team').toBe(DENIED);
		expect((await c.joinerApi.patch(`${D1}/items/physical_samples/${c.sampleId}`, { data: { owner_person_id: c.joiner.personId } })).status(), 'nor make themselves the owner').toBe(DENIED);
		expect(await readStatus(c.joinerApi, c.sampleId), 'and nothing changed').toBe(200);
		expect((await listOf(c.admin, c.sampleId)).owner.team_id).toBe(c.teamId);

		// The manager can manage: the list says so, and sharing works at once for a person who could not see the record.
		expect((await listOf(c.m, c.sampleId)).can_manage, 'the manager may manage').toBe(true);
		const shared = await personEntry(c.m, c.sampleId, c.stranger.personId, 'view');
		expect(shared.status(), `the manager shares: ${shared.status()}`).toBeLessThan(300);
		await expect.poll(() => readStatus(c.strangerApi, c.sampleId), { message: 'the stranger reads once shared' }).toBe(200);
		expect(await editStatus(c.strangerApi, c.sampleId), 'Can view only: no edit').toBe(DENIED);

		// In the browser. The manager gets the controls; the plain member gets the sentence and no controls; the rail shows the team.
		const mp = await pageAs(browser, ...account('member'));
		ctxs.push(mp.context);
		await mp.page.goto(samplePage(c));
		await expect(mp.page.getByRole('heading', { name: c.sampleCode, exact: true })).toBeVisible();
		await expect(mp.page.getByRole('complementary', { name: 'Record' }).getByText(c.teamName).first(), 'the rail shows the owner team').toBeVisible();
		await mp.page.getByRole('button', { name: 'Who has access' }).click();
		const md = dialogOf(mp.page);
		await expect(md.getByRole('button', { name: 'Transfer ownership…' })).toBeVisible();
		await expect(md.getByRole('combobox', { name: 'Add people or teams by name' })).toBeVisible();
		await expect(md.locator('li.row.owner')).toContainText(`${c.teamName} (managers)`);

		const jp = await pageAs(browser, c.joiner.email, c.joiner.password);
		ctxs.push(jp.context);
		await jp.page.goto(samplePage(c));
		await expect(jp.page.getByRole('heading', { name: c.sampleCode, exact: true })).toBeVisible();
		await expect(jp.page.getByRole('button', { name: /^Edit$/ })).toBeVisible();
		await jp.page.getByRole('button', { name: 'Who has access' }).click();
		const jd = dialogOf(jp.page);
		await expect(jd.getByText(`Only ${c.teamName}'s managers can change who has access.`)).toBeVisible();
		await expect(jd.locator('li.row.owner')).toContainText(`${c.teamName} (managers)`);
		await expect(jd.getByRole('button', { name: 'Transfer ownership…' })).toHaveCount(0);
		await expect(jd.getByRole('combobox')).toHaveCount(0);
		await expect(jd.getByRole('checkbox', { name: /Restricted/ })).toHaveCount(0);
	} finally {
		for (const x of ctxs) await x.close().catch(() => undefined);
		await c.cleanup();
	}
});

test('demoting a manager removes sharing at once, promoting gives it; the manager deletes, the member could not', async ({ playwright }) => {
	const c = await cast(playwright);
	try {
		expect((await transfer(c.ownerApi, c.sampleId, { team_id: c.teamId })).status(), 'the owner transfers the sample to the team').toBe(200);
		await expect.poll(() => readStatus(c.joinerApi, c.sampleId), { message: 'the plain member reads' }).toBe(200);
		expect((await personEntry(c.joinerApi, c.sampleId, c.stranger.personId, 'view')).status(), 'a plain member cannot share').toBe(DENIED);

		// Promote the member: a second manager, so the same rows now carry `manage` for them (the manager flag changes the derived role).
		const up = await c.m.patch(`${TEAMS}/${c.teamId}/members/${c.joiner.personId}`, { data: { is_manager: true } });
		expect(up.ok(), `promote: ${up.status()}`).toBeTruthy();
		await expect.poll(async () => (await listOf(c.joinerApi, c.sampleId)).can_manage, { message: 'the promoted member may manage' }).toBe(true);
		const shared = await personEntry(c.joinerApi, c.sampleId, c.stranger.personId, 'view');
		expect(shared.status(), `the new manager shares: ${shared.status()}`).toBeLessThan(300);
		await expect.poll(() => readStatus(c.strangerApi, c.sampleId), { message: 'the stranger reads' }).toBe(200);

		// Demote them (M stays a manager, so the last-manager rule allows it): sharing stops at once, reading and editing stay.
		const down = await c.m.patch(`${TEAMS}/${c.teamId}/members/${c.joiner.personId}`, { data: { is_manager: false } });
		expect(down.ok(), `demote: ${down.status()}`).toBeTruthy();
		const after = await listOf(c.joinerApi, c.sampleId); // no poll: the answer must be immediate
		expect(after.can_manage, 'demoted: may not manage').toBe(false);
		expect((await personEntry(c.joinerApi, c.sampleId, c.owner.personId, 'view')).status(), 'demoted: cannot share').toBe(DENIED);
		expect(await deleteStatus(c.joinerApi, c.sampleId), 'demoted: cannot delete').toBe(DENIED);
		expect(await readStatus(c.joinerApi, c.sampleId), 'demoted: still reads').toBe(200);
		expect(await editStatus(c.joinerApi, c.sampleId), 'demoted: still edits').toBe(200);
		expect((await listOf(c.m, c.sampleId)).can_manage, 'the first manager is unaffected').toBe(true);

		// A manager can delete the team-owned record (the positive control of the refusals above).
		expect(await deleteStatus(c.m, c.sampleId), 'the manager deletes the record').toBe(204);
		c.track.records.length = 0;
		const left = (await (await c.admin.get(`${D1}/items/physical_samples?filter[sample_id][_eq]=${c.sampleId}&fields=sample_id`)).json()).data as unknown[];
		expect(left.length, 'it is gone').toBe(0);
	} finally {
		await c.cleanup();
	}
});

test('Ruling O3: a Lab Member cannot create a record with owner_team_id; the same record without it is fine', async ({ playwright }) => {
	const c = await cast(playwright);
	try {
		const code = `E2E-O3-${unique()}`;
		const refused = await c.m.post(`${D1}/items/physical_samples`, { data: { sample_code: code, item_type: 'sample', current_status: 'active', owner_team_id: c.teamId } });
		expect(refused.status(), 'owner_team_id on create is refused to a Lab Member').toBe(DENIED);
		const nothing = (await (await c.admin.get(`${D1}/items/physical_samples?filter[sample_code][_eq]=${code}&fields=sample_id`)).json()).data as unknown[];
		expect(nothing.length, 'nothing was created').toBe(0);

		const fine = await c.m.post(`${D1}/items/physical_samples?fields=sample_id,owner_person_id,owner_team_id`, { data: { sample_code: `${code}-b`, item_type: 'sample', current_status: 'active' } });
		expect(fine.status(), `the same sample without owner_team_id: ${fine.status()}`).toBe(200);
		const body = (await fine.json()).data as { sample_id: string; owner_person_id: string | null; owner_team_id: string | null };
		c.track.records.push({ collection: 'physical_samples', id: body.sample_id });
		expect(body.owner_person_id, 'the creator owns it (d1-owner-default)').toBeTruthy();
		expect(body.owner_team_id).toBeNull();
	} finally {
		await c.cleanup();
	}
});

test('Ruling O4: a transfer to a team with no manager is refused (409 TEAM_HAS_NO_MANAGER), in the dialog too', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	let ctx: BrowserContext | undefined;
	try {
		// An empty team (no members, so no manager): only an administrator can make one, through the items API.
		const emptyName = `E2E Empty ${unique()}`;
		const made = await c.admin.post(`${D1}/items/teams?fields=team_id`, { data: { name: emptyName } });
		expect(made.ok(), `an empty team: ${made.status()}`).toBeTruthy();
		const emptyId = (await made.json()).data.team_id as string;
		c.track.teams.push(emptyId);

		const r = await transfer(c.ownerApi, c.sampleId, { team_id: emptyId });
		expect(r.status()).toBe(409);
		expect(await errorCode(r)).toBe('TEAM_HAS_NO_MANAGER');

		// The dialog shows the refusal and stays on the confirm step; the owner is unchanged.
		const o = await pageAs(browser, c.owner.email, c.owner.password);
		ctx = o.context;
		await o.page.goto(samplePage(c));
		await o.page.getByRole('button', { name: 'Who has access' }).click();
		const dialog = dialogOf(o.page);
		await dialog.getByRole('button', { name: 'Transfer ownership…' }).click();
		await dialog.getByRole('combobox', { name: 'New owner, by name' }).fill(emptyName);
		await dialog.getByRole('option', { name: new RegExp(emptyName) }).click();
		await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
		await expect(dialog.getByRole('alert')).toContainText('has no manager');
		await expect(dialog.getByRole('button', { name: 'Confirm transfer' })).toBeVisible();
		const list = await listOf(c.admin, c.sampleId);
		expect(list.owner.kind, 'still the owner person').toBe('person');
		expect(list.owner.person_id).toBe(c.owner.personId);
		expect((await listOf(c.admin, c.sampleId)).teams.length, 'and no grant was added').toBe(0);
	} finally {
		await ctx?.close().catch(() => undefined);
		await c.cleanup();
	}
});

test('a team that owns a record cannot be deleted (the page says what it owns); transfer back to a person clears the team', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	const ctxs: BrowserContext[] = [];
	try {
		expect((await transfer(c.ownerApi, c.sampleId, { team_id: c.teamId })).status()).toBe(200);

		// The manager tries to delete the team on its page: refused, with the counts, nothing deleted.
		const mp = await pageAs(browser, ...account('member'));
		ctxs.push(mp.context);
		mp.page.on('dialog', (d) => void d.accept());
		await mp.page.goto(`${STAR_BASE}/teams/${c.teamId}`);
		await expect(mp.page.getByRole('heading', { name: c.teamName }).first()).toBeVisible();
		await expect(mp.page.getByText('Owns').first(), 'the page lists what the team owns').toBeVisible();
		await mp.page.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(mp.page.getByRole('alert')).toContainText(`${c.teamName} owns 1 sample`);
		await expect(mp.page.getByRole('alert')).toContainText('Transfer ownership of them');
		const refused = await c.m.delete(`${TEAMS}/${c.teamId}`);
		expect(refused.status()).toBe(409);
		expect(await errorCode(refused)).toBe('TEAM_OWNS_RECORDS');
		const counts = ((await refused.json()) as { errors: { extensions: { counts: Record<string, number> } }[] }).errors[0].extensions.counts;
		expect(counts.physical_samples).toBe(1);
		expect((await c.m.get(`${TEAMS}/${c.teamId}`)).status(), 'the team is still there').toBe(200);
		const detail = await (await c.admin.get(`${TEAMS}/${c.teamId}`)).json();
		expect(detail.counts.owns, 'GET /d1-teams/:id counts what it owns').toBe(1);

		// The manager transfers the sample back to OWNER in the browser: the page warns that the managers lose access (Ruling O5).
		await mp.page.goto(samplePage(c));
		await mp.page.getByRole('button', { name: 'Who has access' }).click();
		const dialog = dialogOf(mp.page);
		await dialog.getByRole('button', { name: 'Transfer ownership…' }).click();
		await dialog.getByRole('combobox', { name: 'New owner, by name' }).fill(c.owner.name);
		await dialog.getByRole('option', { name: new RegExp(c.owner.name) }).click();
		await expect(dialog.getByRole('status').filter({ hasText: 'becomes the owner' })).toContainText(`You and the other managers of ${c.teamName} will lose access unless you are added back.`);
		await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
		// The page re-reads after a transfer (it can change who may edit): the manager just gave away their only way in (Ruling O5),
		// so it now says the record is not visible to them.
		await expect(mp.page.getByText('Not found or not visible to you')).toBeVisible();

		// Nothing of the team is left: no owner team, no derived rows (the members lose access), and the team can be deleted.
		const row = (await (await c.admin.get(`${D1}/items/physical_samples/${c.sampleId}?fields=owner_person_id,owner_team_id`)).json()).data as { owner_person_id: string; owner_team_id: string | null };
		expect(row.owner_team_id, 'owner_team_id is cleared').toBeNull();
		expect(row.owner_person_id).toBe(c.owner.personId);
		expect(await readStatus(c.ownerApi, c.sampleId), 'the person owner reads').toBe(200);
		expect(await readStatus(c.m, c.sampleId), 'the manager lost access').toBe(DENIED);
		expect(await readStatus(c.joinerApi, c.sampleId), 'so did the plain member').toBe(DENIED);
		expect((await listOf(c.ownerApi, c.sampleId)).teams.length, 'no team entry remains').toBe(0);
		expect((await c.m.delete(`${TEAMS}/${c.teamId}`)).status(), 'now the team can be deleted').toBe(200);
		c.track.teams.length = 0;
	} finally {
		for (const x of ctxs) await x.close().catch(() => undefined);
		await c.cleanup();
	}
});

test('a team-owned orphan operation is read by the team and not by a stranger (the amnesty does not open it)', async ({ playwright }) => {
	const c = await cast(playwright);
	try {
		const method = ((await (await c.admin.get(`${D1}/items/manufacturing_methods?filter[method_code][_eq]=MT&fields=method_id`)).json()).data as { method_id: string }[])[0];
		const sample = ((await (await c.admin.get(`${D1}/items/physical_samples?limit=1&filter[restricted][_neq]=true&fields=sample_id`)).json()).data as { sample_id: string }[])[0];
		expect(method && sample, 'a method and a sample to hang the operations on').toBeTruthy();
		const make = async (owner: Record<string, string | null>) => {
			const r = await c.admin.post(`${D1}/items/manufacturing_operations?fields=operation_id,owner_person_id,owner_team_id,project_id,campaign_id`, { data: { method_id: method.method_id, sample_id: sample.sample_id, ...owner } });
			expect(r.ok(), `create an operation: ${r.status()} ${await r.text()}`).toBeTruthy();
			const op = (await r.json()).data as { operation_id: string; project_id: string | null; campaign_id: string | null; owner_person_id: string | null; owner_team_id: string | null };
			c.track.records.push({ collection: 'manufacturing_operations', id: op.operation_id });
			return op;
		};
		const opStatus = async (api: APIRequestContext, id: string) => (await api.get(`${D1}/items/manufacturing_operations/${id}?fields=operation_id`)).status();

		const teamOp = await make({ owner_team_id: c.teamId });
		expect(teamOp.owner_person_id).toBeNull();
		expect(teamOp.project_id, 'an orphan: no project').toBeNull();
		expect(teamOp.campaign_id, 'an orphan: no campaign').toBeNull();
		await expect.poll(() => opStatus(c.joinerApi, teamOp.operation_id), { message: 'a team member reads the team-owned operation' }).toBe(200);
		expect(await opStatus(c.m, teamOp.operation_id), 'the manager reads it').toBe(200);
		expect(await opStatus(c.strangerApi, teamOp.operation_id), 'a stranger does not: it is not open to all').toBe(DENIED);

		// The contrast: an operation nobody owns is open to every member (the orphan amnesty), so the refusal above is the team's.
		const open = await make({ owner_person_id: null, owner_team_id: null });
		expect(open.owner_person_id, 'nobody owns it').toBeNull();
		await expect.poll(() => opStatus(c.strangerApi, open.operation_id), { message: 'the ownerless orphan is open to a stranger' }).toBe(200);
	} finally {
		await c.cleanup();
	}
});
