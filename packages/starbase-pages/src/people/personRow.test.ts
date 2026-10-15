import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import PersonRow from './PersonRow.vue';
import type { PeopleRow } from './peopleQuery';

const render = async (row: PeopleRow, admin = true) => (await renderToString(createSSRApp({ render: () => h(PersonRow, { row, admin, selected: false, rowKey: row.person_id ?? `login:${row.user_id}` }) }))).replace(/<!--.*?-->/g, '');

const person = (over: Partial<PeopleRow> = {}): PeopleRow => ({
	kind: 'person', person_id: 'p1', full_name: 'Ann Member', email: null, is_researcher: true, is_operator: false, active: true, notes: null, user_id: 'u1',
	login: { status: 'active', role_id: 'r1', role_name: 'Lab Member', last_access: null, email: null }, attention: [], ...over,
});

describe('PersonRow', () => {
	it('puts the account role in the status line, which a phone shows under the name', async () => {
		const html = await render(person());
		expect(html).toMatch(/<span class="status"[^>]*><span class="meta"[^>]*>Lab Member<\/span><\/span>/);
		expect(html).toContain('class="meta when"'); // the last sign-in stays its own cell, at the right
	});

	it('puts a warning in the status line instead of the role, only when something is off', async () => {
		const html = await render(person({ attention: ['missing_email'] }));
		expect(html).toMatch(/<span class="status"[^>]*><span class="flag"[^>]*>Missing email<\/span><\/span>/);
		expect(html).not.toContain('Lab Member');
	});

	it('a login without a person carries its Link action in the status line, with its role and Suspended', async () => {
		const html = await render({
			...person({ kind: 'login', person_id: null, full_name: 'Olga Orphan', email: 'o@x.org', attention: ['login_without_person'] }),
			login: { status: 'suspended', role_id: 'r1', role_name: 'Lab Member', last_access: null, email: 'o@x.org' },
		});
		expect(html).toMatch(/<span class="status"[^>]*><button[^>]*class="link"[^>]*>Link to a person…<\/button><span class="meta"[^>]*>Lab Member · Suspended<\/span><\/span>/);
	});

	it('a member sees no status line at all', async () => {
		expect(await render(person(), false)).not.toContain('class="status"');
	});
});
