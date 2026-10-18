import { expect, type APIRequestContext, type Locator, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { D1, STAR, listRecords } from './localStack';

// What a person does on the process map's edit mode (`/map?edit=...`), as helpers for the specs that run against the LOCAL STACK
// (tests/ui/specs/edit-mode*.spec.ts). Everything here goes through the page the way a person would (clicks, keys, drags) except
// reading state back, which uses Directus's and d1-build's REST API as the account under test.

export type Ref = { collection: string; id: string };
export interface DraftBody {
	items: { key: string; kind: 'sample' | 'operation' | 'test'; existing?: { id: string; version: number }; remove?: true; workState?: string; rows?: { key: string }[]; values: Record<string, unknown> }[];
	wires: { from: { key: string; row?: number }; to: { key: string; row?: number } }[];
	positions: Record<string, { x: number; y: number }>;
	projectId: string | null;
	campaignId: string | null;
}

export const DRAFT_URL = /[?&]edit=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
export const draftIdOf = (page: Page): string => {
	const m = DRAFT_URL.exec(page.url());
	if (!m) throw new Error(`no draft in ${page.url()}`);
	return m[1];
};

/** The saved body of the draft the page has open, read as `api`'s account (what a reload would show). */
export async function readDraft(api: APIRequestContext, id: string): Promise<DraftBody> {
	const r = await api.get(`${D1}/d1-build/drafts/${id}`);
	expect(r.ok(), `GET draft ${id}: ${r.status()}`).toBeTruthy();
	return (await r.json()).data.body as DraftBody;
}

/** Waits until what the page saved satisfies `ok` (the page saves a moment after each change): no sleeping, it polls the server. */
export async function savedDraft(page: Page, api: APIRequestContext, ok: (b: DraftBody) => boolean, what: string): Promise<DraftBody> {
	const id = draftIdOf(page);
	let last: DraftBody | null = null;
	await expect
		.poll(async () => ok((last = await readDraft(api, id))), { message: `the saved draft: ${what}`, timeout: 15_000 })
		.toBe(true)
		.catch((e: Error) => {
			e.message += `\nlast saved body: ${JSON.stringify(last)}`;
			throw e;
		});
	return readDraft(api, id);
}

// ---- the canvas ------------------------------------------------------------------------------------------------------------

export const canvasOf = (page: Page): Locator => page.locator('.pm-canvas');
export const createButton = (page: Page): Locator => page.locator('.pm-create').getByRole('button');
/** Every card of the canvas (Vue Flow nodes; a card's accessible name is "<code or title>, <kind>"). */
export const cards = (page: Page): Locator => canvasOf(page).locator('.vue-flow__node[aria-label]');
export const card = (page: Page, label: string | RegExp): Locator =>
	canvasOf(page).locator('.vue-flow__node').and(page.getByRole('group', typeof label === 'string' ? { name: label, exact: true } : { name: label }));
export const wires = (page: Page): Locator => canvasOf(page).locator('.d1-wire');
/** The drawn wire from a socket whose id starts with `from` to one whose id starts with `to` (a wire's id is `<from socket>><to socket>`). */
export const wireBetween = (page: Page, from: string, to: string): Locator => canvasOf(page).locator(`.vue-flow__edge[data-id^="${from}"][data-id*=">${to}"]`);
/** A click on the wire's hit path (the page selects it so Delete takes it). The click lands at the middle of the path's box. */
export async function clickWire(page: Page, wire: Locator): Promise<void> {
	await wire.locator('.hit').click();
}

export interface Box { x: number; y: number; width: number; height: number }
export async function boxOf(l: Locator): Promise<Box> {
	const b = await l.boundingBox();
	if (!b) throw new Error(`no box for ${l}`);
	return b;
}
/** The boxes of every drawn card by its label. */
export async function cardBoxes(page: Page): Promise<Map<string, Box>> {
	const out = new Map<string, Box>();
	const n = await cards(page).count();
	for (let i = 0; i < n; i++) {
		const c = cards(page).nth(i);
		const label = (await c.getAttribute('aria-label')) ?? `#${i}`;
		const id = (await c.getAttribute('data-id')) ?? label;
		out.set(`${id}`, await boxOf(c));
	}
	return out;
}
export const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Every pair of cards whose boxes overlap, as "idA x idB" (an empty list is what the layout rule promises). */
export async function overlaps(page: Page): Promise<string[]> {
	const boxes = [...(await cardBoxes(page))];
	const out: string[] = [];
	for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i][1], boxes[j][1])) out.push(`${boxes[i][0]} x ${boxes[j][0]}`);
	return out;
}

/** The map's viewport transform (Vue Flow's pane): it stops changing when a fit or a pan has finished. */
const paneTransform = (page: Page): Promise<string> => page.locator('.vue-flow__transformationpane').evaluate((el) => getComputedStyle(el).transform);
export async function viewportSettled(page: Page): Promise<void> {
	let last = '';
	await expect
		.poll(async () => {
			const now = await paneTransform(page);
			const same = now === last;
			last = now;
			return same;
		}, { message: 'the map viewport stops moving', intervals: [150, 150, 150, 250, 250], timeout: 10_000 })
		.toBe(true);
}
/** The Fit button: everything on the canvas in view, so a mouse can reach it. */
export async function fit(page: Page): Promise<void> {
	await page.getByRole('button', { name: /^Fit$/ }).click();
	await viewportSettled(page);
	await expect(page.locator('.pm-canvas.pending')).toHaveCount(0);
}

/** True when the whole of `l` is inside the canvas panel (a mouse can reach it). */
export async function inView(page: Page, l: Locator): Promise<boolean> {
	const [b, cv] = [await boxOf(l), await boxOf(canvasOf(page))];
	return b.x >= cv.x && b.y >= cv.y && b.x + b.width <= cv.x + cv.width && b.y + b.height <= cv.y + cv.height;
}
/** Fits the map when `l` is not all in view (the map keeps its viewport when something is added, so new cards can be off screen). */
export async function reach(page: Page, l: Locator): Promise<void> {
	if (!(await inView(page, l))) await fit(page);
	expect(await inView(page, l), `${l} is in view after Fit`).toBe(true);
}

/** Selects a card by clicking its title (not a socket, ＋ or slot). */
export async function selectCard(page: Page, c: Locator): Promise<void> {
	await reach(page, c);
	await c.locator('.code, .oname .n').first().click();
	// Selected: the lid's Remove is on (edit mode), or the card is drawn focal (view mode has no lid).
	if (await page.getByRole('toolbar', { name: 'Edit mode' }).count()) await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
	else await expect(c.locator(".node.focal")).toHaveCount(1);
}

// ---- starting and building a draft -----------------------------------------------------------------------------------------

export async function openNewDraft(page: Page): Promise<string> {
	await page.goto(`${STAR}/map?edit=new`, { waitUntil: 'domcontentloaded' });
	await page.waitForURL(DRAFT_URL);
	await expect(page.getByRole('button', { name: /Pick samples/ })).toBeVisible();
	return draftIdOf(page);
}

/** The sample picker: ticks the given seeded samples in the Samples list and confirms. */
export async function pickSamples(page: Page, codes: string[]): Promise<void> {
	await page.getByRole('button', { name: /Pick samples/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Pick samples' });
	for (const code of codes) await dialog.getByRole('row', { name: new RegExp(code) }).getByRole('checkbox').check();
	await dialog.getByRole('button', { name: new RegExp(`^Add ${codes.length} samples?$`) }).click();
	await expect(dialog).toBeHidden();
	for (const code of codes) await expect(page.getByRole('group', { name: new RegExp(`^${code}, Sample`) })).toBeVisible();
}

/** Opens a socket's add menu from the keyboard (Enter on the socket) and chooses one entry of it. */
export async function chooseFromSocketMenu(page: Page, socket: Locator, entry: RegExp): Promise<void> {
	await socket.press('Enter');
	await page.locator('.pm-addmenu').getByRole('option', { name: entry }).click();
	await expect(page.locator('.pm-addmenu')).toBeHidden();
}

export const sockOf = (page: Page, sock: string): Locator => canvasOf(page).locator(`[data-sock="${sock}"]`);
export const freeSockOf = (page: Page, sock: string): Locator => canvasOf(page).locator(`.free[data-sock="${sock}"]`);
/** The row sockets of the one draft container that has `side` sockets (the sole new operation of a draft). */
export const rowSock = (page: Page, side: 'in' | 'out'): Locator => canvasOf(page).locator(`[data-sock^="row|draft:"][data-sock$="|${side}"]`);

/** Picks a sample, adds a CNC Turning from its output socket and a new sample out of the operation. Returns the picked sample's id. */
export async function buildTurningWithNewSample(page: Page, api: APIRequestContext, code: string): Promise<{ sampleId: string }> {
	await openNewDraft(page);
	const sampleId = await sampleIdOf(api, code);
	await pickSamples(page, [code]);
	await chooseFromSocketMenu(page, sockOf(page, `sample|${sampleId}|out`).first(), /CNC Turning/);
	await chooseFromSocketMenu(page, rowSock(page, 'out').first(), /^New sample/);
	await expect(createButton(page)).toHaveText('Create 1 operation, 1 sample');
	return { sampleId };
}

export async function sampleIdOf(api: APIRequestContext, code: string): Promise<string> {
	const [row] = await listRecords<{ sample_id: string }>(api, 'physical_samples', `filter[sample_code][_eq]=${code}&fields=sample_id`);
	expect(row, `the seed sample ${code}`).toBeTruthy();
	return row.sample_id;
}

export interface CreateAnswer {
	status: number;
	body: { data?: { created: Record<string, Ref & { code: string }>; sampleIds: string[] }; errors?: { message: string; extensions: { code: string } }[] };
}
/** Presses Create and returns what d1-build answered. `onMade` is told of every record it created, for the clean-up. */
export async function pressCreate(page: Page, onMade?: (r: Ref) => void): Promise<CreateAnswer> {
	const answered = page.waitForResponse((r) => /\/d1-build\/drafts\/[^/]+\/create$/.test(r.url()) && r.request().method() === 'POST');
	await createButton(page).click();
	const response = await answered;
	const body = (await response.json()) as CreateAnswer['body'];
	for (const ref of Object.values(body.data?.created ?? {})) onMade?.({ collection: ref.collection, id: ref.id });
	return { status: response.status(), body };
}

/** The distinct records a Create made (the map holds one entry per draft KEY: an operation is under its item key and its row key). */
export const distinctRecords = (created: Record<string, Ref>): Ref[] => [...new Map(Object.values(created).map((r) => [r.id, r])).values()];

// ---- pointer work --------------------------------------------------------------------------------------------------------------

export const centreOf = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** A pointer drag from a point to a point in several moves (the page needs real pointermoves; it listens on the window). */
export async function dragBetween(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps });
	await page.mouse.up();
}
/**
 * Drags a card by its title by `by` screen pixels (or onto `to`). Checks first that the title really is what is under the pointer, so a
 * card covered by another says so instead of the other one being dragged.
 */
export async function dragCard(page: Page, c: Locator, by: { x: number; y: number } | null, to?: { x: number; y: number }): Promise<void> {
	await reach(page, c);
	const id = await c.getAttribute('data-id');
	const handle = await boxOf(c.locator('.ntop, .ohead').first());
	const from = { x: handle.x + Math.min(40, handle.width / 3), y: handle.y + handle.height / 2 };
	const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.vue-flow__node')?.getAttribute('data-id') ?? null, from);
	expect(under, `the card ${id} is what is under the pointer at ${from.x},${from.y}`).toBe(id);
	await dragBetween(page, from, to ?? { x: from.x + by!.x, y: from.y + by!.y });
}
export async function dragFrom(page: Page, source: Locator, to: { x: number; y: number }): Promise<void> {
	await dragBetween(page, centreOf(await boxOf(source)), to);
}
/** An empty spot of the canvas, clear of every card, the controls and the minimap: the middle of the free strip under the cards. */
export async function emptySpot(page: Page): Promise<{ x: number; y: number }> {
	const cv = await boxOf(canvasOf(page));
	const boxes = [...(await cardBoxes(page)).values()];
	const bottom = Math.max(...boxes.map((b) => b.y + b.height), cv.y);
	const y = Math.min(bottom + 70, cv.y + cv.height - 130);
	for (const x of [cv.x + cv.width * 0.5, cv.x + cv.width * 0.3, cv.x + cv.width * 0.7]) {
		const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.vue-flow__node, .vue-flow__controls, .vue-flow__minimap, .vue-flow__edge') !== null, { x, y });
		if (!hit) return { x, y };
	}
	throw new Error('no empty spot on the canvas');
}

/** A card's position in the map's own coordinates (Vue Flow's node transform): it does not depend on the viewport, so a reload can be compared. */
export async function flowPos(l: Locator): Promise<{ x: number; y: number }> {
	return l.evaluate((el) => {
		const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)/.exec((el as HTMLElement).style.transform);
		if (!m) throw new Error(`no node transform: ${(el as HTMLElement).style.transform}`);
		return { x: Number(m[1]), y: Number(m[2]) };
	});
}
/** Every card's flow position by node id. */
export async function flowPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
	const out: Record<string, { x: number; y: number }> = {};
	const n = await cards(page).count();
	for (let i = 0; i < n; i++) {
		const c = cards(page).nth(i);
		out[(await c.getAttribute('data-id')) ?? `#${i}`] = await flowPos(c);
	}
	return out;
}
/** The pairs of overlapping cards once the layout has stopped moving (two identical snapshots in a row: cards glide to their place). */
export async function settledOverlaps(page: Page): Promise<string[]> {
	let last = '';
	await expect
		.poll(async () => {
			const now = JSON.stringify(await flowPositions(page)) + JSON.stringify([...(await cardBoxes(page))].map(([, b]) => [b.width, b.height]));
			const same = now === last;
			last = now;
			return same;
		}, { message: 'the cards stop moving', intervals: [200, 200, 300, 400], timeout: 15_000 })
		.toBe(true);
	return overlaps(page);
}

/** The lid's Add button, then one entry of its menu. */
export async function addFromLid(page: Page, entry: RegExp): Promise<void> {
	await page.getByRole('button', { name: /^Add\b/ }).first().click();
	await page.locator('.pm-addmenu').getByRole('option', { name: entry }).click();
	await expect(page.locator('.pm-addmenu')).toBeHidden();
}
/** Duplicate ×N of the selected card (Ctrl+Shift+D asks how many). */
export async function duplicateMany(page: Page, n: number): Promise<void> {
	await page.keyboard.press('Control+Shift+D');
	const dialog = page.getByRole('dialog', { name: /^Duplicate / });
	await dialog.getByRole('spinbutton').fill(String(n));
	await page.keyboard.press('Enter');
	await expect(dialog).toBeHidden();
}

/**
 * Where each wire's drawn ends are, relative to the centre of the socket's Handle they join (in the map's own units, so a zoom does not change them; by "<wire id> <socket id>").
 * Vue Flow ends a wire at the edge of the Handle, so the offsets are small and constant while the wire follows its socket: the same
 * numbers before and after a change mean the wire is still on its socket, a different number means the socket moved and the wire did not.
 */
export async function wireEndOffsets(page: Page): Promise<Record<string, { dx: number; dy: number } | 'no socket'>> {
	return canvasOf(page).evaluate((root) => {
		const out: Record<string, { dx: number; dy: number } | 'no socket'> = {};
		for (const g of root.querySelectorAll('.vue-flow__edge')) {
			const id = g.getAttribute('data-id') ?? '';
			const [from, to] = id.split('>');
			const path = g.querySelector('path.wire') as SVGPathElement | null;
			const ctm = path?.getScreenCTM();
			if (!path || !ctm) continue;
			const end = (len: number) => {
				const p = path.getPointAtLength(len);
				return new DOMPoint(p.x, p.y).matrixTransform(ctm);
			};
			for (const [socket, at] of [[from, end(0)], [to, end(path.getTotalLength())]] as const) {
				const el = root.querySelector(`[data-handleid="${CSS.escape(socket)}"]`);
				if (!el) {
					out[`${id} ${socket}`] = 'no socket';
					continue;
				}
				const r = el.getBoundingClientRect();
				out[`${id} ${socket}`] = { dx: Math.round(((at.x - (r.left + r.width / 2)) / ctm.a) * 10) / 10, dy: Math.round(((at.y - (r.top + r.height / 2)) / ctm.a) * 10) / 10 };
			}
		}
		return out;
	});
}
/** The wire ends that are further from where they were (`rest`, from `wireEndOffsets` earlier) than `tolerance` map units: wires that did not follow their socket. */
export async function driftedWires(page: Page, rest: Awaited<ReturnType<typeof wireEndOffsets>>, tolerance = 1.5): Promise<string[]> {
	const now = await wireEndOffsets(page);
	const out: string[] = [];
	for (const [key, was] of Object.entries(rest)) {
		const is = now[key];
		if (was === 'no socket' || is === 'no socket' || !is) continue;
		const d = Math.hypot(is.dx - was.dx, is.dy - was.dy);
		if (d > tolerance) out.push(`${key}: ${Math.round(d)}px from where it met its socket at rest`);
	}
	return out;
}

/** A click on an empty spot of the canvas: lets go of the selection. */
export async function clickEmpty(page: Page): Promise<void> {
	const at = await emptySpot(page);
	await page.mouse.click(at.x, at.y);
}
/** Where every card is, as an offset from the card with the lowest id: the arrangement, whatever the viewport does. */
export async function relativeLayout(page: Page): Promise<Record<string, { x: number; y: number }>> {
	const all = [...(await cardBoxes(page))].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	const [, first] = all[0];
	return Object.fromEntries(all.map(([id, b]) => [id, { x: b.x - first.x, y: b.y - first.y }]));
}

// ---- records made through the API --------------------------------------------------------------------------------------------

/**
 * A planned operation (CNC Turning) on the seeded sample `inputCode` with a planned output sample, made through Directus's REST API
 * as `api`'s account. `note` is told of each record, for the clean-up. `root` reads the seed (an admin).
 */
export async function makePlanned(api: APIRequestContext, root: APIRequestContext, inputCode: string, note: (r: Ref) => void): Promise<{ operationId: string; sampleId: string; code: string; inputId: string }> {
	const [input] = await listRecords<{ sample_id: string; material_id: string; project_id: string }>(root, 'physical_samples', `filter[sample_code][_eq]=${inputCode}&fields=sample_id,material_id,project_id`);
	const [method] = await listRecords<{ method_id: string }>(root, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
	const code = `LOCAL-PLN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
	const sample = await api.post(`${D1}/items/physical_samples`, { data: { sample_code: code, current_status: 'planned', material_id: input.material_id, form: 'cylinder', project_id: input.project_id } });
	expect(sample.ok(), `planned sample: ${await sample.text()}`).toBeTruthy();
	const sampleId = (await sample.json()).data.sample_id as string;
	note({ collection: 'physical_samples', id: sampleId });
	const op = await api.post(`${D1}/items/manufacturing_operations`, {
		data: { sample_id: input.sample_id, output_sample_id: sampleId, method_id: method.method_id, work_state: 'planned', process_category: 'machining' },
	});
	expect(op.ok(), `planned operation: ${await op.text()}`).toBeTruthy();
	const operationId = (await op.json()).data.operation_id as string;
	note({ collection: 'manufacturing_operations', id: operationId });
	return { operationId, sampleId, code, inputId: input.sample_id };
}

/**
 * A planned operation the Lab Member OWNS (so may edit) whose planned output sample belongs to the Lab Admin's person: the member may
 * read that sample but not write it (the access rules' sample.editors). Made by the admin through the REST API. The output sample has a
 * manufacturing method, which making it active asks for.
 */
export async function makeTechSituation(admin: APIRequestContext, member: APIRequestContext, note: (r: Ref) => void): Promise<{ operationId: string; sampleId: string; ownerPersonId: string }> {
	const personOf = async (api: APIRequestContext): Promise<string> => {
		const me = await (await api.get(`${D1}/users/me?fields=id`)).json();
		return (await listRecords<{ person_id: string }>(admin, 'people', `filter[user_id][_eq]=${me.data.id}&fields=person_id`))[0].person_id;
	};
	const [memberPerson, adminPerson] = [await personOf(member), await personOf(admin)];
	const [input] = await listRecords<{ sample_id: string; material_id: string; project_id: string }>(admin, 'physical_samples', 'filter[sample_code][_eq]=LOCAL-RAW-2&fields=sample_id,material_id,project_id');
	const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
	const code = `LOCAL-TECH-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
	const sample = await admin.post(`${D1}/items/physical_samples`, {
		data: { sample_code: code, current_status: 'planned', material_id: input.material_id, form: 'cylinder', project_id: input.project_id, owner_person_id: adminPerson, primary_method_id: method.method_id },
	});
	expect(sample.ok(), `output sample: ${await sample.text()}`).toBeTruthy();
	const sampleId = JSON.parse(await sample.text()).data.sample_id as string;
	note({ collection: 'physical_samples', id: sampleId });
	const op = await admin.post(`${D1}/items/manufacturing_operations`, {
		data: { sample_id: input.sample_id, output_sample_id: sampleId, method_id: method.method_id, work_state: 'planned', process_category: 'machining', owner_person_id: memberPerson },
	});
	expect(op.ok(), `operation: ${await op.text()}`).toBeTruthy();
	const operationId = JSON.parse(await op.text()).data.operation_id as string;
	note({ collection: 'manufacturing_operations', id: operationId });
	return { operationId, sampleId, ownerPersonId: adminPerson };
}

const ROLE_MEMBER = '10000001-0000-0000-0000-000000000002';
/** A second Lab Member (made by the admin, signed in through the API): someone who owns none of the seed's records. */
export async function secondMember(
	playwright: PlaywrightWorkerArgs['playwright'],
	admin: APIRequestContext,
	note: (u: { userId: string; personId: string | null }) => void,
): Promise<{ api: APIRequestContext; personId: string }> {
	const suffix = Math.random().toString(36).slice(2, 8);
	const email = `local-member-2-${suffix}@example.com`;
	const password = `Mb2-${Math.random().toString(36).slice(2)}-Zq9!`;
	const made = await admin.post(`${D1}/users`, { data: { email, password, role: ROLE_MEMBER, first_name: 'Second', last_name: 'Member', status: 'active' } });
	expect(made.ok(), `second member: ${await made.text()}`).toBeTruthy();
	const userId = JSON.parse(await made.text()).data.id as string;
	const [person] = await listRecords<{ person_id: string }>(admin, 'people', `filter[user_id][_eq]=${userId}&fields=person_id`);
	note({ userId, personId: person?.person_id ?? null });
	const anon = await playwright.request.newContext();
	const login = await anon.post(`${D1}/auth/login`, { data: { email, password, mode: 'json' } });
	expect(login.ok(), 'second member login').toBeTruthy();
	const token = (await login.json()).data.access_token as string;
	await anon.dispose();
	return { api: await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } }), personId: person.person_id };
}

/** Opens the Process map of a record and chooses Edit (the draft is made from what the map shows). Returns the draft's id. */
export async function startEditingMapOf(page: Page, collection: string, id: string): Promise<string> {
	await page.goto(`${STAR}/map?focus=${collection}:${id}`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.waitForURL(DRAFT_URL);
	await expect(page.getByRole('toolbar', { name: 'Edit mode' })).toBeVisible();
	return draftIdOf(page);
}
