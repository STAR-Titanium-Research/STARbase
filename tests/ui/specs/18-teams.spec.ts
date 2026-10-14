import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { D1_LOCAL, STAR_BASE, account, adminApi, pointAtD1 } from '../starbase/target';

// Teams (People 2: d1-teams + d1-record-access team entries + STARbase Teams view, team page, Who has access and Home "Waiting for
// you"), in a real browser against the d1-starbase preview, ports layout, same setup as spec 14 (tests/ui/README.md). The preview
// overlay needs d1-teams, d1-record-access, d1-people-admin and d1-person-link (the preview script's default has them). Migrations
// 175 and 176 are on the preview copy. Run: npx playwright test specs/18-teams.spec.ts
//
// Cast, all made by the tests and removed in `finally`: the preview Lab Member ("Preview Member", M) creates the teams and is their
// manager; OWNER owns a Restricted sample; JOINER and OTHER are further Lab Members with a person each (d1-person-link makes the
// person). The preview has no mail transport, so mails are not asserted (the endpoints' unit tests cover them).
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
async function makeLogin(api: APIRequestContext, label: string): Promise<Login> {
	const tag = unique();
	const email = `e2e-teams-${label.toLowerCase()}-${tag}@example.com`;
	const password = `E2e-${tag}-Passw0rd!`;
	const made = await api.post(`${D1}/users`, { data: { email, password, status: 'active', role: await labMemberRole(api), first_name: `E2E${label}`, last_name: tag } });
	expect(made.ok(), `create the ${label} login: ${made.status()}`).toBeTruthy();
	const userId = (await made.json()).data.id as string;
	let person: { person_id: string; full_name: string } | undefined;
	await expect.poll(async () => {
		const r = await api.get(`${D1}/items/people?filter[user_id][_eq]=${userId}&fields=person_id,full_name`);
		person = ((await r.json()).data as { person_id: string; full_name: string }[])[0];
		return !!person;
	}, { message: `the person of the ${label} login` }).toBe(true);
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

// What the whole cast needs: M's API session, the cast, a team M manages and a Restricted sample OWNER owns. cleanup() removes it all,
// whatever state a test left it in (teams first: a team that holds members blocks nothing, but its grants must go before the sample).
interface Cast {
	admin: APIRequestContext;
	m: APIRequestContext;
	mPersonId: string;
	owner: Login;
	joiner: Login;
	teamId: string;
	teamName: string;
	sampleId: string;
	sampleCode: string;
	cleanup: () => Promise<void>;
}

async function cast(pw: Pw, opts: { share?: 'edit' | 'view' | false } = {}): Promise<Cast> {
	const admin = await adminApi(pw);
	const [memberEmail, memberPassword] = account('member');
	const m = await apiAs(pw, memberEmail, memberPassword);
	const created: { users: string[]; people: string[] } = { users: [], people: [] };
	const state = { teams: [] as string[], sample: '' };
	const cleanup = async () => {
		for (const id of state.teams) await admin.delete(`${TEAMS}/${id}`);
		if (state.sample) await admin.delete(`${D1}/items/physical_samples/${state.sample}`);
		for (const id of created.people) await admin.delete(`${D1}/items/people/${id}`);
		for (const id of created.users) await admin.delete(`${D1}/users/${id}`);
		await m.dispose();
		await admin.dispose();
	};
	try {
		const me = ((await (await admin.get(`${D1}/items/people?filter[full_name][_eq]=Preview Member&fields=person_id`)).json()).data as { person_id: string }[])[0];
		expect(me, 'the preview member has a person').toBeTruthy();
		const owner = await makeLogin(admin, 'Owner');
		created.users.push(owner.userId);
		created.people.push(owner.personId);
		const joiner = await makeLogin(admin, 'Joiner');
		created.users.push(joiner.userId);
		created.people.push(joiner.personId);

		const teamName = `E2E Team ${unique()}`;
		const made = await m.post(TEAMS, { data: { name: teamName } });
		expect(made.status(), 'the member creates a team').toBe(201);
		const teamId = (await made.json()).team_id as string;
		state.teams.push(teamId);

		const sampleCode = `E2E-T-${unique()}`;
		const s = await admin.post(`${D1}/items/physical_samples?fields=sample_id`, {
			data: { sample_code: sampleCode, item_type: 'sample', current_status: 'active', owner_person_id: owner.personId, restricted: true },
		});
		expect(s.ok(), `create the sample: ${s.status()} ${await s.text()}`).toBeTruthy();
		const sampleId = (await s.json()).data.sample_id as string;
		state.sample = sampleId;

		const c: Cast = { admin, m, mPersonId: me.person_id, owner, joiner, teamId, teamName, sampleId, sampleCode, cleanup };
		if (opts.share !== false) {
			const ownerApi = await apiAs(pw, owner.email, owner.password);
			try {
				const r = await ownerApi.post(`${ACCESS}/physical_samples/${sampleId}/entries`, { data: { team_id: teamId, role: opts.share ?? 'edit' } });
				expect(r.ok(), `the owner shares the sample with the team: ${r.status()} ${await r.text()}`).toBeTruthy();
			} finally {
				await ownerApi.dispose();
			}
		}
		return c;
	} catch (e) {
		await cleanup();
		throw e;
	}
}

const readStatus = async (api: APIRequestContext, sampleId: string) => (await api.get(`${D1}/items/physical_samples/${sampleId}?fields=sample_id,notes`)).status();
const editStatus = async (api: APIRequestContext, sampleId: string) => (await api.patch(`${D1}/items/physical_samples/${sampleId}`, { data: { notes: `e2e ${unique()}` } })).status();
const samplePage = (c: Cast) => `${STAR_BASE}/samples/${encodeURIComponent(c.sampleId)}`;
const addMember = (c: Cast, personId: string, isManager = false) => c.admin.post(`${TEAMS}/${c.teamId}/members`, { data: { person_id: personId, is_manager: isManager } });
const dialogOf = (page: Page) => page.getByRole('dialog', { name: /who has access/i });

test('a team grant gives an active member read and edit on a Restricted sample (and the member did not have it before)', async ({ playwright, browser }) => {
	const c = await cast(playwright, { share: false });
	const owner = await apiAs(playwright, c.owner.email, c.owner.password);
	let ctx: BrowserContext | undefined;
	try {
		// Before the share: M is not the owner, the sample is Restricted: nothing.
		expect(await readStatus(c.m, c.sampleId), 'before the grant').not.toBe(200);

		// The owner adds the team in the browser: Who has access -> "Add people or teams" -> pick the team -> Can edit -> Add.
		const o = await pageAs(browser, c.owner.email, c.owner.password);
		ctx = o.context;
		await o.page.goto(samplePage(c));
		await o.page.getByRole('button', { name: 'Who has access' }).click();
		const dialog = dialogOf(o.page);
		await expect(dialog).toBeVisible();
		await dialog.getByRole('combobox').fill(c.teamName);
		await dialog.getByRole('option', { name: new RegExp(c.teamName) }).click();
		await dialog.getByLabel(`Level for the team ${c.teamName}`).selectOption({ label: 'Can edit' });
		await dialog.getByRole('button', { name: 'Add', exact: true }).click();
		const row = dialog.locator('li.row.team', { hasText: c.teamName });
		await expect(row).toBeVisible();
		await expect(row).toContainText('1 member');
		await expect(dialog.getByRole('alert')).toHaveCount(0);

		// M can now read and edit it, by API and in the browser.
		await expect.poll(() => readStatus(c.m, c.sampleId), { message: 'M reads through the team' }).toBe(200);
		expect(await editStatus(c.m, c.sampleId), 'M edits through the team (Can edit)').toBe(200);
		const [memberEmail, memberPassword] = account('member');
		const mp = await pageAs(browser, memberEmail, memberPassword);
		try {
			await mp.page.goto(samplePage(c));
			await expect(mp.page.getByRole('heading', { name: c.sampleCode, exact: true })).toBeVisible();
			await expect(mp.page.getByRole('button', { name: /^Edit$/ })).toBeVisible();
			await expect(mp.page.getByText('Not found or not visible to you')).toHaveCount(0);
		} finally {
			await mp.context.close();
		}
		// The owner's derived rows are consistent.
		const members = await owner.get(`${ACCESS}/physical_samples/${c.sampleId}/entries/team/${c.teamId}/members`);
		expect(members.status()).toBe(200);
		expect(((await members.json()).active as unknown[]).length).toBe(1);
	} finally {
		await ctx?.close().catch(() => undefined);
		await owner.dispose();
		await c.cleanup();
	}
});

test('a joiner without trust is pending and cannot read; the owner sees Waiting for you, approves, and the joiner can read and edit', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	const joinerApi = await apiAs(playwright, c.joiner.email, c.joiner.password);
	let ctx: BrowserContext | undefined;
	try {
		const added = await addMember(c, c.joiner.personId);
		expect(added.status()).toBe(201);
		const body = await added.json();
		expect(body.pending, 'one record is waiting on the owner').toBe(1);
		expect(body.owners_asked).toBe(1);
		expect(await readStatus(joinerApi, c.sampleId), 'a pending member cannot read').not.toBe(200);

		// The owner's Home: Waiting for you says who and how many records.
		const o = await pageAs(browser, c.owner.email, c.owner.password);
		ctx = o.context;
		await o.page.goto(`${STAR_BASE}/home`);
		await expect(o.page.getByText('Waiting for you', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		const line = o.page.getByText(new RegExp(`${c.joiner.name} joined ${c.teamName} · 1 of your records`));
		await expect(line).toBeVisible();
		await o.page.getByRole('button', { name: 'Approve all' }).click();
		await expect(line).toBeHidden();
		await expect(o.page.getByText('Waiting for you', { exact: true })).toHaveCount(0);

		await expect.poll(() => readStatus(joinerApi, c.sampleId), { message: 'the approved joiner reads' }).toBe(200);
		expect(await editStatus(joinerApi, c.sampleId), 'and edits (the grant is Can edit)').toBe(200);

		// The joiner's own page shows the sample.
		const jp = await pageAs(browser, c.joiner.email, c.joiner.password);
		try {
			await jp.page.goto(samplePage(c));
			await expect(jp.page.getByRole('heading', { name: c.sampleCode, exact: true })).toBeVisible();
		} finally {
			await jp.context.close();
		}
	} finally {
		await ctx?.close().catch(() => undefined);
		await joinerApi.dispose();
		await c.cleanup();
	}
});

test('declining keeps the joiner out; the owner can approve later from Who has access', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	const joinerApi = await apiAs(playwright, c.joiner.email, c.joiner.password);
	let ctx: BrowserContext | undefined;
	try {
		expect((await addMember(c, c.joiner.personId)).status()).toBe(201);
		const o = await pageAs(browser, c.owner.email, c.owner.password);
		ctx = o.context;
		await o.page.goto(`${STAR_BASE}/home`);
		await o.page.getByRole('button', { name: 'Decline all' }).click();
		await expect(o.page.getByText('Waiting for you', { exact: true })).toHaveCount(0);
		expect(await readStatus(joinerApi, c.sampleId), 'declined: no access').not.toBe(200);

		// Who has access: "0 waiting · 1 declined" -> expand -> Approve.
		await o.page.goto(samplePage(c));
		await o.page.getByRole('button', { name: 'Who has access' }).click();
		const dialog = dialogOf(o.page);
		const row = dialog.locator('li.row.team', { hasText: c.teamName });
		await row.getByRole('button', { name: /0 waiting · 1 declined/ }).click();
		await row.getByRole('button', { name: `Approve ${c.joiner.name}` }).click();
		await expect.poll(() => readStatus(joinerApi, c.sampleId), { message: 'approved after a decline' }).toBe(200);
	} finally {
		await ctx?.close().catch(() => undefined);
		await joinerApi.dispose();
		await c.cleanup();
	}
});

test('Trust future members: the next joiner reads at once, with nobody to approve', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	const joinerApi = await apiAs(playwright, c.joiner.email, c.joiner.password);
	let ctx: BrowserContext | undefined;
	try {
		const o = await pageAs(browser, c.owner.email, c.owner.password);
		ctx = o.context;
		await o.page.goto(samplePage(c));
		await o.page.getByRole('button', { name: 'Who has access' }).click();
		const dialog = dialogOf(o.page);
		const row = dialog.locator('li.row.team', { hasText: c.teamName });
		const trust = row.getByLabel('Trust future members');
		await expect(trust).not.toBeChecked();
		await trust.check();
		await expect(trust).toBeChecked();
		await expect(dialog.getByRole('alert')).toHaveCount(0);

		const added = await addMember(c, c.joiner.personId);
		expect(added.status()).toBe(201);
		expect((await added.json()).pending, 'a trusted grant leaves nobody pending').toBe(0);
		await expect.poll(() => readStatus(joinerApi, c.sampleId), { message: 'the joiner reads at once' }).toBe(200);
	} finally {
		await ctx?.close().catch(() => undefined);
		await joinerApi.dispose();
		await c.cleanup();
	}
});

test('leaving removes access at once (the Leave button on the team page)', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	const joinerApi = await apiAs(playwright, c.joiner.email, c.joiner.password);
	let ctx: BrowserContext | undefined;
	try {
		// Trust it so the joiner is active, then the joiner leaves through the UI.
		const ownerApi = await apiAs(playwright, c.owner.email, c.owner.password);
		try {
			const r = await ownerApi.patch(`${ACCESS}/physical_samples/${c.sampleId}/entries/team/${c.teamId}`, { data: { trust_new_members: true } });
			expect(r.ok()).toBeTruthy();
		} finally {
			await ownerApi.dispose();
		}
		expect((await addMember(c, c.joiner.personId)).status()).toBe(201);
		await expect.poll(() => readStatus(joinerApi, c.sampleId)).toBe(200);

		const j = await pageAs(browser, c.joiner.email, c.joiner.password);
		ctx = j.context;
		j.page.on('dialog', (d) => void d.accept());
		await j.page.goto(`${STAR_BASE}/teams/${c.teamId}`);
		await expect(j.page.getByRole('heading', { name: c.teamName }).first()).toBeVisible();
		await j.page.getByRole('button', { name: 'Leave', exact: true }).click();
		await expect(j.page).toHaveURL(`${STAR_BASE}/people?view=teams`);
		await expect.poll(() => readStatus(joinerApi, c.sampleId), { message: 'access ends when the member leaves' }).not.toBe(200);
		expect(await editStatus(joinerApi, c.sampleId)).not.toBe(200);
		// and the team no longer lists them
		const detail = await (await c.admin.get(`${TEAMS}/${c.teamId}`)).json();
		expect((detail.members as { person_id: string }[]).some((x) => x.person_id === c.joiner.personId)).toBe(false);
	} finally {
		await ctx?.close().catch(() => undefined);
		await joinerApi.dispose();
		await c.cleanup();
	}
});

test('hover and keyboard focus on a team row in Who has access show the members card', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	let ctx: BrowserContext | undefined;
	try {
		expect((await addMember(c, c.joiner.personId)).status()).toBe(201);
		const o = await pageAs(browser, c.owner.email, c.owner.password);
		ctx = o.context;
		await o.page.goto(samplePage(c));
		await o.page.getByRole('button', { name: 'Who has access' }).click();
		const dialog = dialogOf(o.page);
		const row = dialog.locator('li.row.team', { hasText: c.teamName });
		const trigger = row.getByRole('button', { name: new RegExp(`^${c.teamName}\\..*2 members.*Show members`) });
		const card = o.page.getByRole('group', { name: `Team ${c.teamName}` });

		// Mouse hover opens the card with the members (M is the manager); leaving closes it.
		await trigger.hover();
		await expect(card).toBeVisible();
		await expect(card).toContainText('Preview Member');
		await expect(card).toContainText('manager');
		await expect(card).toContainText(c.joiner.name);
		await o.page.mouse.move(5, 5);
		await expect(card).toBeHidden();

		// Keyboard focus opens it too (focus stays on the trigger: it is a disclosure), Escape closes the card and not the dialog.
		await trigger.focus();
		await expect(card).toBeVisible();
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(trigger).toBeFocused();
		await o.page.keyboard.press('Escape');
		await expect(card).toBeHidden();
		await expect(dialog).toBeVisible();
	} finally {
		await ctx?.close().catch(() => undefined);
		await c.cleanup();
	}
});

test('the last manager cannot leave: the page says "Make someone else a manager first" and nothing changes', async ({ playwright, browser }) => {
	const c = await cast(playwright, { share: false });
	let ctx: BrowserContext | undefined;
	try {
		expect((await addMember(c, c.joiner.personId)).status()).toBe(201); // a second member, not a manager
		const [memberEmail, memberPassword] = account('member');
		const mp = await pageAs(browser, memberEmail, memberPassword);
		ctx = mp.context;
		mp.page.on('dialog', (d) => void d.accept());
		await mp.page.goto(`${STAR_BASE}/teams/${c.teamId}`);
		await expect(mp.page.getByRole('heading', { name: c.teamName }).first()).toBeVisible();
		await mp.page.getByRole('button', { name: 'Leave', exact: true }).click();
		await expect(mp.page.getByRole('alert')).toContainText('Make someone else a manager first');
		await expect(mp.page).toHaveURL(new RegExp(`/teams/${c.teamId}`));
		// still the manager, and the API agrees (409 LAST_MANAGER on a direct call too)
		const r = await c.m.delete(`${TEAMS}/${c.teamId}/members/${c.mPersonId}`);
		expect(r.status()).toBe(409);
		expect((await r.json()).errors[0].extensions.code).toBe('LAST_MANAGER');
		// Make the joiner a manager: now the first manager may leave.
		expect((await c.m.patch(`${TEAMS}/${c.teamId}/members/${c.joiner.personId}`, { data: { is_manager: true } })).ok()).toBeTruthy();
		await mp.page.reload();
		await mp.page.getByRole('button', { name: 'Leave', exact: true }).click();
		await expect(mp.page).toHaveURL(`${STAR_BASE}/people?view=teams`);
	} finally {
		await ctx?.close().catch(() => undefined);
		await c.cleanup();
	}
});

test('member: the People | Teams switch lists the team and its page loads (members, records, history)', async ({ playwright, browser }) => {
	const c = await cast(playwright);
	let ctx: BrowserContext | undefined;
	try {
		const [memberEmail, memberPassword] = account('member');
		const mp = await pageAs(browser, memberEmail, memberPassword);
		ctx = mp.context;
		await mp.page.goto(`${STAR_BASE}/home/people`);
		await expect(mp.page.locator('.prow').first()).toBeVisible({ timeout: 30_000 });
		await mp.page.getByRole('radio', { name: 'Teams' }).or(mp.page.getByRole('button', { name: 'Teams', exact: true })).first().click();
		await expect(mp.page).toHaveURL(/[?&]view=teams/);
		const list = mp.page.getByRole('list', { name: 'Teams' });
		const row = list.getByRole('listitem').filter({ hasText: c.teamName });
		await expect(row).toBeVisible();
		await expect(row).toContainText('1 member');
		await expect(row).toContainText('Managed by Preview Member');
		await row.getByRole('button', { name: c.teamName }).click();
		await expect(mp.page).toHaveURL(new RegExp(`/teams/${c.teamId}`));
		await expect(mp.page.getByRole('heading', { name: c.teamName }).first()).toBeVisible();
		await expect(mp.page.getByText('1 members · 1 records').or(mp.page.getByText(/1 member · 1 record/))).toBeVisible();
		await expect(mp.page.getByRole('region', { name: 'Members' })).toBeVisible();
		await expect(mp.page.getByText('manager', { exact: true }).first()).toBeVisible();
		// Records: the member reads the shared sample through the team, so it is listed; History has the creation and the share.
		await expect(mp.page.getByRole('link', { name: c.sampleCode })).toBeVisible();
		await expect(mp.page.getByText(/shared/i).first()).toBeVisible();
		await expect(mp.page.getByText(/created/i).first()).toBeVisible();
		// Reload keeps the page; a deep link works.
		await mp.page.reload();
		await expect(mp.page.getByRole('heading', { name: c.teamName }).first()).toBeVisible();
	} finally {
		await ctx?.close().catch(() => undefined);
		await c.cleanup();
	}
});

test('the people-admin access counts (person_access on real Postgres) show a pending joiner as waiting', async ({ playwright }) => {
	const c = await cast(playwright);
	try {
		expect((await addMember(c, c.joiner.personId)).status()).toBe(201);
		// person_access returns the five numbers, the new ones (teams, waiting) included.
		const r = await c.admin.get(`${D1}/d1-people-admin/people/${c.joiner.personId}/access`);
		expect(r.status()).toBe(200);
		const counts = await r.json();
		for (const k of ['owns', 'shared', 'investigator', 'teams', 'waiting']) expect(typeof counts[k], `person_access.${k}`).toBe('number');
		expect(counts.waiting, 'the joiner is waiting on one record').toBe(1);
	} finally {
		await c.cleanup();
	}
});
