import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { D1_BASE, D1_LOCAL, STAR_BASE, account, adminApi, pointAtD1, signInStarbase } from '../starbase/target';

// The admin People page (People 1: d1-people-admin + STARbase /people and /accept-invite), in a real browser against the
// d1-starbase preview, ports layout, same setup as spec 14 (tests/ui/README.md). The preview overlay needs d1-people-admin and
// d1-record-access (the preview script's default has both). Run: npx playwright test specs/17-people-admin.spec.ts
// The preview has no mail transport, so the invite test asserts the row ("Invite not accepted"), not delivery.
test.use({ trace: 'off' });

const PEOPLE = `${D1_LOCAL}/d1-people-admin`;
const MEMBER_NAME = 'Preview Member'; // the preview script's Lab Member (a people row linked to its login)
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

interface ApiPerson { person_id: string; full_name: string; user_id: string | null; login: { status: string; role_name: string | null } | null }
async function listPeople(api: APIRequestContext): Promise<ApiPerson[]> {
	const r = await api.get(`${PEOPLE}/people`);
	expect(r.status(), 'GET /d1-people-admin/people').toBe(200);
	return (await r.json()).people as ApiPerson[];
}
// The preview member's ids (found by name: the script makes exactly one "Preview Member").
async function memberIds(api: APIRequestContext): Promise<{ personId: string; userId: string }> {
	const m = (await listPeople(api)).find((p) => p.full_name === MEMBER_NAME && p.user_id);
	expect(m, 'the preview member has a person row and a login').toBeTruthy();
	return { personId: m!.person_id, userId: m!.user_id! };
}
// Directus signs the member in only through its own endpoint; this also stamps last_access.
async function memberLogin(playwright: Parameters<typeof adminApi>[0]): Promise<number> {
	const [email, password] = account('member');
	const anon = await playwright.request.newContext();
	try {
		return (await anon.post(`${D1_LOCAL}/auth/login`, { data: { email, password, mode: 'json' } })).status();
	} finally {
		await anon.dispose();
	}
}
// A login with no person, so the attention item login_without_person exists whatever the copy holds. d1-person-link makes a person for
// every new login; this deletes it. Remove the login with removeOrphanLogin.
async function orphanLogin(api: APIRequestContext): Promise<{ userId: string; email: string }> {
	const email = `e2e-orphan-${unique()}@example.com`;
	const made = await api.post(`${D1_LOCAL}/users`, { data: { email, status: 'active' } });
	expect(made.ok(), 'create a login without a person').toBeTruthy();
	const userId = (await made.json()).data.id as string;
	try {
		const linkedIds = async () => ((await (await api.get(`${D1_LOCAL}/items/people?filter[user_id][_eq]=${userId}&fields=person_id`)).json()).data as { person_id: string }[]).map((r) => r.person_id);
		await expect.poll(async () => (await linkedIds()).length).toBe(1);
		for (const id of await linkedIds()) expect((await api.delete(`${D1_LOCAL}/items/people/${id}`)).ok(), 'delete the auto-made person').toBeTruthy();
	} catch (e) {
		await api.delete(`${D1_LOCAL}/users/${userId}`); // the caller never gets the id, so the login is removed here
		throw e;
	}
	return { userId, email };
}
const removeOrphanLogin = async (api: APIRequestContext, userId: string) => {
	expect((await api.delete(`${D1_LOCAL}/users/${userId}`)).ok(), 'remove the throwaway login').toBeTruthy();
};
const row = (page: Page, text: string | RegExp) => page.locator('.prow', { hasText: text }).first();
const panel = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
async function openPeople(page: Page, query = ''): Promise<void> {
	await page.goto(`${STAR_BASE}/people${query}`);
	await expect(page.locator('.prow').first()).toBeVisible({ timeout: 30_000 });
}

test('the three SQL functions run on real Postgres: /people, /attention and /people/:id/access answer, never 500', async ({ playwright }) => {
	const api = await adminApi(playwright);
	try {
		const people = await api.get(`${PEOPLE}/people`);
		expect(people.status()).toBe(200);
		const body = await people.json();
		expect(body.can_administer_accounts, 'the preview admin (an admin policy on the user, no role) administers accounts').toBe(true);
		expect(Array.isArray(body.people) && body.people.length > 0).toBe(true);
		expect(Array.isArray(body.logins_without_person)).toBe(true);

		const attention = await api.get(`${PEOPLE}/attention`);
		expect(attention.status()).toBe(200);
		const items = (await attention.json()).items as { key: string; count: number }[];
		expect(Array.isArray(items)).toBe(true);
		for (const i of items) expect(i.count).toBeGreaterThan(0);

		// person_access: the three counts, and each of the three lists (shared goes through the readers/access tables).
		const ids = (body.people as ApiPerson[]).slice(0, 6).map((p) => p.person_id);
		for (const id of ids) {
			const counts = await api.get(`${PEOPLE}/people/${id}/access`);
			expect(counts.status(), `access counts for ${id}`).toBe(200);
			const c = await counts.json();
			for (const k of ['owns', 'shared', 'investigator']) expect(typeof c[k]).toBe('number');
			for (const list of ['owns', 'shared', 'investigator']) {
				const r = await api.get(`${PEOPLE}/people/${id}/access?list=${list}`);
				expect(r.status(), `access list=${list} for ${id}`).toBe(200);
				expect(Array.isArray((await r.json()).records)).toBe(true);
			}
		}
		// A person who really has something listed: scan until a list comes back non-empty (the live copy has owners).
		let listed = 0;
		for (const p of body.people as ApiPerson[]) {
			const r = await api.get(`${PEOPLE}/people/${p.person_id}/access?list=shared`);
			expect(r.status()).toBe(200);
			listed += ((await r.json()).records as unknown[]).length;
			if (listed) break;
		}
		test.info().annotations.push({ type: 'note', description: `shared records listed for the first person that has any: ${listed}` });
	} finally {
		await api.dispose();
	}
});

test('admin: chips and Sort change the URL and survive reload', async ({ page }) => {
	await signInStarbase(page, 'admin');
	await openPeople(page, '?f=former&sort=last');
	const former = page.locator('.fc', { hasText: 'Former' });
	await expect(former).toHaveAttribute('aria-pressed', 'true');
	const sort = page.locator('select').filter({ hasText: 'Sort: Name' });
	await expect(sort).toHaveValue(/.+/);
	await expect(sort.locator('option:checked')).toHaveText('Sort: Last sign-in');

	// A chip click and a Sort change are written to the URL ...
	await page.locator('.fc', { hasText: 'Operators' }).click();
	await expect(page).toHaveURL(/[?&]f=operators/);
	await sort.selectOption({ label: 'Sort: Recently added' });
	await expect(page).toHaveURL(/[?&]sort=added/);
	// ... and a reload brings the same view back.
	await page.reload();
	await expect(page.locator('.fc', { hasText: 'Operators' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('select').filter({ hasText: 'Sort: Name' }).locator('option:checked')).toHaveText('Sort: Recently added');
	expect(new URL(page.url()).searchParams.get('f')).toBe('operators');
	// Back to Everyone: the default is not kept in the URL.
	await page.locator('.fc', { hasText: 'Everyone' }).click();
	await expect(page).not.toHaveURL(/[?&]f=/);
});

test('admin: the attention line opens a filtered list', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	let userId: string | undefined;
	try {
		const orphan = await orphanLogin(api);
		userId = orphan.userId;
		const email = orphan.email;
		await signInStarbase(page, 'admin');
		await openPeople(page);
		const line = page.locator('.attn');
		await expect(line).toContainText(/things? needs? attention/);
		await line.getByRole('button', { name: 'review' }).click();
		const item = page.locator('[data-open-menu]').getByRole('button', { name: /logins? with no person/ });
		await expect(item).toBeVisible();
		await item.click();
		await expect(page).toHaveURL(/[?&]attn=login_without_person/);
		await expect(page.locator('.attn')).toContainText('Showing');
		// Only logins without a person are listed, each with its "Link to a person…" action, and ours is one of them.
		await expect(row(page, email)).toBeVisible();
		const rows = page.locator('.prow');
		const n = await rows.count();
		expect(n).toBeGreaterThan(0);
		await expect(page.getByRole('button', { name: 'Link to a person…' })).toHaveCount(n);
		// "clear" leaves the filter.
		await page.locator('.attn').getByRole('button', { name: 'clear' }).click();
		await expect(page).not.toHaveURL(/attn=/);
	} finally {
		if (userId) await removeOrphanLogin(api, userId);
		await api.dispose();
	}
});

test('admin: person panel shows account role and last sign-in; role change round-trips', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	try {
		const { personId, userId } = await memberIds(api);
		expect(await memberLogin(playwright), 'the member can sign in (stamps last sign-in)').toBe(200);
		const roleOf = async () => (await (await api.get(`${D1_LOCAL}/users/${userId}?fields=role.name`)).json()).data.role?.name as string;
		expect(await roleOf()).toBe('Lab Member');

		await signInStarbase(page, 'admin');
		await openPeople(page, `?q=${encodeURIComponent(MEMBER_NAME)}`);
		await row(page, MEMBER_NAME).click();
		await expect(page).toHaveURL(new RegExp(`person=${personId}`));
		const p = panel(page, MEMBER_NAME);
		await expect(p).toBeVisible();
		const account = p.getByRole('region', { name: 'Account' });
		const role = account.locator('select.role');
		await expect(role.locator('option:checked')).toHaveText('Lab Member');
		await expect(role).toBeEnabled();
		await expect(account.getByText('Last sign-in')).toBeVisible();
		await expect(account.locator('.f', { hasText: 'Last sign-in' })).toContainText(/just now|min ago|h ago/);
		// Access: the four counts load (SQL person_access through the panel: owns, shared, investigator, and since PR 2 through teams).
		await expect(p.getByRole('region', { name: 'Access' }).getByRole('button', { name: /records?$/ })).toHaveCount(4);

		// Lab Member -> Lab Admin ...
		await role.selectOption({ label: 'Lab Admin' });
		await expect.poll(roleOf).toBe('Lab Admin');
		await expect(row(page, MEMBER_NAME)).toContainText('Lab Admin');
		// ... and back.
		await role.selectOption({ label: 'Lab Member' });
		await expect.poll(roleOf).toBe('Lab Member');
		await expect(row(page, MEMBER_NAME)).toContainText('Lab Member');
		await expect(account.locator('[role="alert"]')).toHaveCount(0);
	} finally {
		// Whatever happened, leave the member a Lab Member.
		const { userId } = await memberIds(api);
		const lm = (await listRoles(api)).find((r) => r.name === 'Lab Member');
		if (lm) await api.patch(`${PEOPLE}/logins/${userId}`, { data: { role: lm.id } });
		await api.dispose();
	}
});
async function listRoles(api: APIRequestContext): Promise<{ id: string; name: string }[]> {
	return (await (await api.get(`${PEOPLE}/people`)).json()).roles;
}

test('admin: suspend and reactivate the member login; the member is signed out', async ({ browser, page, playwright }) => {
	const api = await adminApi(playwright);
	const { personId, userId } = await memberIds(api);
	const memberCtx = await browser.newContext();
	try {
		// The member is signed in on its own page.
		const mpage = await memberCtx.newPage();
		await signInStarbase(mpage, 'member');
		await mpage.goto(`${STAR_BASE}/people`);
		await expect(mpage.locator('.prow').first()).toBeVisible({ timeout: 30_000 });

		await signInStarbase(page, 'admin');
		await openPeople(page, `?person=${personId}`);
		const p = panel(page, MEMBER_NAME);
		const login = p.locator('.f', { hasText: 'Login' }).filter({ hasNotText: 'Last sign-in' });
		await expect(login).toContainText('Active');
		await login.getByRole('button', { name: 'Suspend' }).click();
		await expect(login).toContainText('Suspended');
		await expect(row(page, MEMBER_NAME)).toContainText('Suspended');
		expect((await (await api.get(`${D1_LOCAL}/users/${userId}?fields=status`)).json()).data.status).toBe('suspended');

		// The member's next request is signed out: its session rows are gone, so the API says 401 and STARbase goes to sign-in.
		const status = await mpage.evaluate(async (d1) => (await fetch(`${d1}/users/me`, { credentials: 'include' })).status, D1_BASE);
		expect(status, "the member's next request").toBe(401);
		await mpage.reload();
		await expect(mpage).toHaveURL(/\/signin/, { timeout: 30_000 });
		expect(await memberLogin(playwright), 'a suspended login cannot sign in').not.toBe(200);

		// Reactivate: the member can sign in again.
		await login.getByRole('button', { name: 'Reactivate' }).click();
		await expect(login).toContainText('Active');
		await expect(login.getByRole('button', { name: 'Suspend' })).toBeVisible();
		expect(await memberLogin(playwright), 'a reactivated login signs in').toBe(200);
	} finally {
		await api.patch(`${PEOPLE}/logins/${userId}`, { data: { status: 'active' } });
		await memberCtx.close();
		await api.dispose();
	}
});

test('admin: invite a new person; the row says "Invite not accepted"; /accept-invite with a bad token says so', async ({ page, browser, playwright }) => {
	const api = await adminApi(playwright);
	const tag = unique();
	const name = `E2E Invitee ${tag}`;
	const email = `e2e-invitee-${tag}@example.com`;
	try {
		await signInStarbase(page, 'admin');
		await openPeople(page);
		await page.getByRole('button', { name: 'Invite', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: /invite someone/i }).or(page.locator('.v-dialog[role="dialog"]'));
		await expect(dialog.first()).toBeVisible();
		await dialog.getByPlaceholder('First Last').fill(name);
		await dialog.getByPlaceholder('name@sheffield.ac.uk').fill(email);
		await expect(dialog.getByText('The invite expires in 7 days.')).toBeVisible();
		await dialog.getByRole('button', { name: 'Send invite' }).click();
		// The preview has no mail transport, so either wording is right; what matters is the login and its row.
		const status = dialog.getByRole('status');
		await expect(status).toContainText(/Invite sent to|could not be sent/, { timeout: 30_000 });
		await expect(status).not.toContainText(/deliver/i);
		await dialog.getByRole('button', { name: 'Done' }).click();
		await expect(dialog.first()).toBeHidden();

		const r = row(page, name);
		await expect(r).toBeVisible({ timeout: 15_000 });
		await expect(r).toContainText('Invite not accepted');
		const made = (await listPeople(api)).find((p) => p.full_name === name);
		expect(made?.login?.status, 'the login is invited and linked to the new person').toBe('invited');
		// Exactly one person holds that login: the invite linked the new person and nothing else (no duplicate from d1-person-link).
		const holders = await api.get(`${D1_LOCAL}/items/people?filter[user_id][_eq]=${made?.user_id}&fields=person_id`);
		expect(holders.ok()).toBeTruthy();
		expect(((await holders.json()).data as unknown[]).length, 'one people row has the invited login').toBe(1);

		// The person's panel offers Resend for an invited login.
		await r.click();
		await expect(panel(page, name).locator('.f', { hasText: 'Login' }).filter({ hasNotText: 'Last sign-in' })).toContainText('Invited');
		await expect(panel(page, name).getByRole('button', { name: 'Resend' })).toBeVisible();

		// A link that does not verify: the page says the invite expired or was already used (a fresh, signed-out browser).
		const anon = await browser.newContext();
		try {
			const ap = await anon.newPage();
			await pointAtD1(anon);
			await ap.goto(`${STAR_BASE}/accept-invite?token=bogus`);
			await expect(ap.getByRole('heading', { name: 'Set your password' })).toBeVisible();
			await ap.getByLabel('New password', { exact: true }).fill('Bogus-Passw0rd-123!');
			await ap.getByLabel('Confirm password').fill('Bogus-Passw0rd-123!');
			await ap.getByRole('button', { name: /set password/i }).click();
			await expect(ap.getByRole('alert')).toContainText('expired or was already used');
			await expect(ap.getByRole('link', { name: 'Sign in' })).toBeVisible();
			// No token at all says the same, at once.
			await ap.goto(`${STAR_BASE}/accept-invite`);
			await expect(ap.getByRole('alert')).toContainText('expired or was already used');
		} finally {
			await anon.close();
		}
	} finally {
		// Clean up the throwaway person and login.
		const made = (await listPeople(api)).find((p) => p.full_name === name);
		if (made) {
			await api.delete(`${D1_LOCAL}/items/people/${made.person_id}`);
			if (made.user_id) await api.delete(`${D1_LOCAL}/users/${made.user_id}`);
		}
		await api.dispose();
	}
});

test('member: no attention line, no Role menu; own row opens the panel; the admin endpoint answers 403', async ({ page, playwright }) => {
	await signInStarbase(page, 'member');
	await openPeople(page);
	await expect(page.locator('.attn')).toHaveCount(0);
	// Only the Sort menu: no "Role: ..." menu, and no "Last sign-in" sort.
	await expect(page.locator('select')).toHaveCount(1);
	await expect(page.locator('select option', { hasText: /^Role:/ })).toHaveCount(0);
	await expect(page.locator('select option', { hasText: 'Last sign-in' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);

	await row(page, MEMBER_NAME).click();
	const p = panel(page, MEMBER_NAME);
	await expect(p).toBeVisible();
	await expect(p.getByRole('region', { name: 'Account' })).toHaveCount(0);
	await expect(p.getByRole('region', { name: 'Access' })).toBeVisible();
	await expect(p.getByRole('button', { name: 'Edit' })).toBeVisible();

	// The endpoint behind the admin page refuses a Lab Member.
	const [email, password] = account('member');
	const anon = await playwright.request.newContext();
	const login = await anon.post(`${D1_LOCAL}/auth/login`, { data: { email, password, mode: 'json' } });
	expect(login.ok()).toBeTruthy();
	const token = (await login.json()).data.access_token as string;
	await anon.dispose();
	const member = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
	try {
		expect((await member.get(`${PEOPLE}/people`)).status()).toBe(403);
		expect((await member.get(`${PEOPLE}/attention`)).status()).toBe(403);
	} finally {
		await member.dispose();
	}
});

test('Esc: a focused select, the Edit dialog and the attention menu each keep the panel open; then Esc closes it and focus returns to the row', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const { personId } = await memberIds(api);
	let userId: string | undefined;
	try {
		userId = (await orphanLogin(api)).userId; // the attention menu needs at least one attention item
		await signInStarbase(page, 'admin');
		await openPeople(page);
		const memberRow = row(page, MEMBER_NAME);
		await memberRow.click();
		const p = panel(page, MEMBER_NAME);
		await expect(p).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`person=${personId}`));

		// 1. A select with focus (the panel's Role select, then the list's Sort select): Esc leaves the panel open. STARbase's selects are
		//    native <select>s, whose popup a headless browser does not draw, so "open" is the focused state here.
		const role = p.locator('select.role');
		await role.focus();
		await page.keyboard.press('Escape');
		await expect(p).toBeVisible();
		const sort = page.locator('select').filter({ hasText: 'Sort: Name' });
		await sort.focus();
		await page.keyboard.press('Escape');
		await expect(p).toBeVisible();

		// 2. The Edit dialog: Esc closes only the dialog; the panel stays; focus goes back to Edit.
		const edit = p.getByRole('button', { name: 'Edit', exact: true });
		await edit.click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(p).toBeVisible();
		await expect(edit).toBeFocused();

		// 3. The attention menu: Esc closes only the menu; the panel stays; focus goes back to "review".
		const review = page.locator('.attn').getByRole('button', { name: 'review' });
		await review.click();
		const menu = page.locator('[data-open-menu]');
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		await expect(p).toBeVisible();
		await expect(review).toBeFocused();

		// 4. Nothing else is open: Esc closes the panel, drops ?person= and puts focus back on the row.
		await page.keyboard.press('Escape');
		await expect(p).toBeHidden();
		await expect(page).not.toHaveURL(/person=/);
		await expect(memberRow).toBeFocused();
	} finally {
		if (userId) await removeOrphanLogin(api, userId);
		await api.dispose();
	}
});

test('phone (390x844): the person panel is a bottom sheet and the list can still scroll its last row clear of it', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const page = await context.newPage();
	try {
		await signInStarbase(page, 'admin');
		await openPeople(page, '?sort=name');
		await page.locator('.prow').first().click();
		const sheet = page.locator('.panel-slot');
		await expect(sheet).toBeVisible();
		const sheetBox = (await sheet.boundingBox())!;
		expect(sheetBox.y + sheetBox.height, 'the sheet sits on the bottom edge').toBeGreaterThan(830);
		expect(sheetBox.height, 'the sheet is at most 70% of the screen').toBeLessThanOrEqual(844 * 0.7 + 2);

		// Scroll the last row as far as the page lets it go, then ask whether the sheet still covers it.
		const last = page.locator('.prow').last();
		await last.scrollIntoViewIfNeeded();
		await page.evaluate(() => {
			for (const el of [document.scrollingElement, ...Array.from(document.querySelectorAll<HTMLElement>('main, .page, .shell, [class*="scroll"]'))]) {
				if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
			}
		});
		await page.waitForTimeout(250);
		const lastBox = (await last.boundingBox())!;
		const sheetTop = (await sheet.boundingBox())!.y;
		expect(lastBox.y + lastBox.height, 'the last row ends above the sheet (the list scrolls clear of it)').toBeLessThanOrEqual(sheetTop + 1);
	} finally {
		await context.close();
	}
});
