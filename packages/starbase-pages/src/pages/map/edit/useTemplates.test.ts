import { describe, expect, it } from 'vitest';
import type { HostApi } from '@d1/ui';
import { fakeServer, httpError, settle } from './fakeBuildServer';
import { NO_TEMPLATES, failureText, useTemplates } from './useTemplates';
import { useGearStatus } from './useGearStatus';

const OP = { method_id: 'm-turn', equipment_id: 'e1', tool_id: 'tool1' };

function setup(me: { id?: string; admin?: boolean } = { id: 'u1' }) {
	const f = fakeServer();
	const gear = useGearStatus(f.api);
	const t = useTemplates({ api: f.api, gear, me: () => me });
	const make = (over: Partial<(typeof f.s.templates)[number]> = {}) => {
		const rec = { id: `t${f.s.templates.length + 1}`, name: 'Roughing', scope: 'private' as const, role_id: null, collection: 'manufacturing_operations' as const, values: OP, user_id: 'u1', updated_at: 'now', version: 1, ...over };
		f.s.templates.push(rec);
		return rec;
	};
	return { ...f, calls: f.s.calls, t, gear, make };
}

describe('reading the templates', () => {
	it('reads the list once and marks the ones this person may change', async () => {
		const x = setup({ id: 'u1' });
		x.make();
		x.make({ id: 't9', name: 'Theirs', scope: 'global', user_id: 'u2' });
		await x.t.ensure();
		await x.t.ensure();
		expect(x.calls.filter((c) => c === 'GET /d1-build/templates')).toHaveLength(1);
		expect(x.t.items.value.map((i) => [i.rec.name, i.mine])).toEqual([['Roughing', true], ['Theirs', false]]);
		expect(x.t.loaded.value).toBe(true);
		expect(x.t.error.value).toBe('');
	});

	it('lets an administrator change every one', async () => {
		const x = setup({ id: 'u3', admin: true });
		x.make();
		await x.t.ensure();
		expect(x.t.items.value[0].mine).toBe(true);
	});

	it('is forbidden quietly for an account that may not build: no templates, no message', async () => {
		const x = setup();
		x.s.templateStatus = 403;
		await x.t.ensure();
		expect(x.t.forbidden.value).toBe(true);
		expect(x.t.items.value).toEqual([]);
		expect(x.t.error.value).toBe('');
		expect(NO_TEMPLATES).toMatch(/may not use templates/);
	});

	it('says so when the list cannot be read, once, and asks again next time', async () => {
		const x = setup();
		x.s.templateStatus = 500;
		await x.t.ensure();
		expect(x.t.error.value).toMatch(/Could not read the templates/);
		expect(x.t.items.value).toEqual([]);
		x.s.templateStatus = 0;
		x.make();
		x.t.dismiss();
		await x.t.ensure();
		expect(x.t.items.value).toHaveLength(1);
	});

	it('reads the state of the gear the templates name and warns about a retired one', async () => {
		const x = setup();
		x.s.gear = { tools: [{ tool_id: 'tool1', tool_name: 'Holder 3', is_active: false }], equipment: [{ equipment_id: 'e1', equipment_name: 'Lathe', is_active: true }] };
		x.make();
		await x.t.ensure();
		await settle();
		expect(x.t.items.value[0].warn).toBe('The tool Holder 3 is retired.');
	});

	it('warns of nothing when the gear cannot be read', async () => {
		const x = setup();
		x.s.gear = {};
		x.make();
		await x.t.ensure();
		await settle();
		expect(x.t.items.value[0].warn).toBeUndefined();
	});
});

describe('using a template', () => {
	it('lists its values cleaned again by the page (a column that is gone, a field the draft now refuses), while the stored template is untouched', async () => {
		const f = fakeServer();
		const t = useTemplates({
			api: f.api,
			gear: useGearStatus(f.api),
			me: () => ({ id: 'u1' }),
			clean: (_c, v) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'dropped_in_a_migration' && k !== 'sintering_run_number')),
		});
		f.s.templates.push({ id: 't1', name: 'Old', scope: 'private', role_id: null, collection: 'manufacturing_operations', values: { method_id: 'm', dropped_in_a_migration: 1, sintering_run_number: 4, equipment_id: 'e' }, user_id: 'u1', updated_at: 'now', version: 1 } as never);
		await t.ensure();
		expect(t.items.value[0].rec.values).toEqual({ method_id: 'm', equipment_id: 'e' });
		expect(t.rows.value[0].values).toHaveProperty('sintering_run_number');
	});
});

describe('making, changing and deleting', () => {
	it('creates a template with a name, a scope and the values, and lists it by name', async () => {
		const x = setup();
		x.make({ name: 'Zed' });
		await x.t.ensure();
		const r = await x.t.create({ name: 'Alpha', scope: 'role', collection: 'manufacturing_operations', values: OP });
		expect(r).toMatchObject({ ok: true, template: { name: 'Alpha', scope: 'role' } });
		expect(x.t.items.value.map((i) => i.rec.name)).toEqual(['Alpha', 'Zed']);
		expect(x.s.templates.find((t) => t.name === 'Alpha')?.values).toEqual(OP);
	});

	it('renames, re-scopes and replaces the values against the version it holds', async () => {
		const x = setup();
		x.make();
		await x.t.ensure();
		expect(await x.t.rename('t1', 'Finishing')).toMatchObject({ ok: true });
		expect(await x.t.setScope('t1', 'global')).toMatchObject({ ok: true });
		expect(await x.t.replaceValues('t1', { method_id: 'm-turn', equipment_id: 'e9' })).toMatchObject({ ok: true });
		expect(x.s.templates[0]).toMatchObject({ name: 'Finishing', scope: 'global', version: 4, values: { method_id: 'm-turn', equipment_id: 'e9' } });
		expect(x.t.rows.value[0].version).toBe(4);
	});

	it('deletes one', async () => {
		const x = setup();
		x.make();
		await x.t.ensure();
		expect(await x.t.remove('t1')).toEqual({ ok: true, template: null });
		expect(x.s.templates).toEqual([]);
		expect(x.t.items.value).toEqual([]);
	});

	it('answers a stale version (409) in plain words and reloads what the server has', async () => {
		const x = setup();
		x.make();
		await x.t.ensure();
		x.s.templates[0].version = 5; // someone else changed it
		x.s.templates[0].name = 'Changed elsewhere';
		const r = await x.t.rename('t1', 'Mine');
		expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/changed since you opened it/) });
		expect(x.t.error.value).toMatch(/try again/);
		expect(x.t.items.value[0].rec).toMatchObject({ name: 'Changed elsewhere', version: 5 });
		expect(await x.t.rename('t1', 'Mine')).toMatchObject({ ok: true });
	});

	it('says 403 when it is not theirs and a gone template (404) in words, and reloads', async () => {
		const x = setup({ id: 'u1' });
		x.make({ user_id: 'u2', scope: 'global' });
		await x.t.ensure();
		expect(await x.t.rename('t1', 'Mine')).toMatchObject({ ok: false, message: expect.stringMatching(/Only the person who made a template/) });
		expect(await x.t.remove('t1')).toMatchObject({ ok: false });
		x.s.templates = [];
		expect(await x.t.rename('t1', 'x')).toMatchObject({ ok: false, message: 'That template does not exist any more.' });
		expect(x.t.items.value).toEqual([]);
	});

	it('says a server error as the server said it, and a lost connection in words', async () => {
		const x = setup();
		x.make();
		await x.t.ensure();
		x.s.templateStatus = -1;
		expect(await x.t.create({ name: 'A', scope: 'private', collection: 'manufacturing_operations', values: OP })).toMatchObject({ ok: false, message: expect.stringMatching(/Could not reach the server/) });
		expect(failureText(httpError(500), 'rename it')).toBe('HTTP 500');
		expect(x.t.busy.value).toBe(false);
	});

	it('does not call the server for a template it does not hold', async () => {
		const x = setup();
		await x.t.ensure();
		expect(await x.t.rename('nope', 'x')).toMatchObject({ ok: false });
		expect(x.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
	});
});

describe('the words of a failure', () => {
	const err = (status: number, message: string) => Object.assign(new Error(message), { response: { status, data: { errors: [{ message }] } } });

	it('a 400 about a column or a field is not shown as the server wrote it; the messages made for people are', () => {
		const dev = 'values names obsolete_col, which is not a column of manufacturing_operations: a template sets columns only.';
		const out = failureText(err(400, dev), 'save the template');
		expect(out).not.toMatch(/column|values names|manufacturing_operations/);
		expect(out).toMatch(/Could not save the template: the server did not accept it/);
		expect(failureText(err(400, 'A name is needed.'), 'rename')).toBe('A name is needed.');
		expect(failureText(err(400, 'A template can only be shared with your own account role.'), 'x')).toBe('A template can only be shared with your own account role.');
		expect(failureText(err(400, 'An operation template needs a method.'), 'save')).not.toMatch(/needs a method/);
	});

	it('the two 403s are told apart: the build gate says the account may not build, the other says only the maker may change it', () => {
		expect(failureText(err(403, 'Your account may not build processes.'), 'save the template')).toBe('Your account may not build processes.');
		expect(failureText(err(403, 'Only the person who made a template, or an administrator, can change it.'), 'x')).toMatch(/^Only the person who made a template/);
		expect(failureText(err(403, 'HTTP 403'), 'x')).toMatch(/^Only the person who made a template/);
	});

	it('404, 409 and a lost connection have their own words', () => {
		expect(failureText(err(404, 'x'), 'x')).toBe('That template does not exist any more.');
		expect(failureText(err(409, 'x'), 'x')).toMatch(/changed since you opened it/);
		expect(failureText(new Error('Network Error'), 'rename the template')).toBe('Could not reach the server to rename the template.');
	});
});

describe('the client talks only through the host api', () => {
	it('uses the one api it was given', async () => {
		const calls: string[] = [];
		const api = { get: async (p: string) => (calls.push(p), { data: { data: [] } }) } as unknown as HostApi;
		const t = useTemplates({ api, gear: useGearStatus(api), me: () => ({}) });
		await t.ensure();
		expect(calls).toEqual(['/d1-build/templates']);
	});
});
