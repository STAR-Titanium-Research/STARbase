import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function loadEnv() {
	const e = { ...process.env };
	try {
		const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m && !(m[1] in e)) e[m[1]] = m[2];
		}
	} catch { /* rely on process env */ }
	return e;
}

export const env = loadEnv();
export const BASE = env.DIRECTUS_TEST_URL || 'http://localhost:8055';
export const LAB_MEMBER_ROLE = '10000001-0000-0000-0000-000000000002';

export function sql(query) {
	const out = execFileSync('docker', ['exec', 'd1-database-postgres-1', 'psql', '-U', 'd1', '-d', 'd1_database',
		'-v', 'ON_ERROR_STOP=1', '-q', '-At', '-F', '\t', '-c', query], { encoding: 'utf8' }).trim();
	return out === '' ? [] : out.split('\n').map((l) => l.split('\t'));
}

export function sqlOne(query) {
	const rows = sql(query);
	return rows[0]?.[0] ?? null;
}

export async function api(method, path, token, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let data;
	try { data = JSON.parse(text); } catch { data = text; }
	return { status: res.status, data };
}

export async function login(email, password) {
	const r = await api('POST', '/auth/login', null, { email, password });
	if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
	return r.data.data.access_token;
}

export function adminToken() {
	return login(env.DIRECTUS_ADMIN_EMAIL, env.DIRECTUS_ADMIN_PASSWORD);
}

export async function createUser(admin, label, { role = LAB_MEMBER_ROLE, first = 'OwnTest', last = label, email } = {}) {
	const password = `Tmp-${Math.random().toString(36).slice(2)}-Aa1!`;
	const addr = email || `own-test-${label.toLowerCase()}-${Date.now()}@example.com`;
	const r = await api('POST', '/users', admin, { email: addr, password, role, status: 'active', first_name: first, last_name: last });
	if (r.status !== 200) throw new Error(`createUser failed: ${JSON.stringify(r.data)}`);
	const userId = r.data.data.id;
	const token = await login(addr, password);
	return { userId, email: addr, password, token };
}

export function personOf(userId) {
	return sqlOne(`SELECT person_id FROM people WHERE user_id = '${userId}'`);
}

export async function deleteUser(admin, userId) {
	sql(`DELETE FROM people WHERE user_id = '${userId}'`);
	await api('DELETE', `/users/${userId}`, admin);
}
