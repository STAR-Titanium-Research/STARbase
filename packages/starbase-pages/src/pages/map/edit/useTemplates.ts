// The client of `/d1-build/templates` (redesign R7): the templates this person may see (their own, their account role's and everyone's), and
// making, renaming, re-scoping, replacing the values of and deleting them. All through the host's API, as the signed-in person; d1-build
// decides who may change what. A change names the version it was made against (the server answers 409 when the template changed since), and
// every failure is said in plain words: nothing here throws at the page.

import { computed, ref, shallowRef } from 'vue';
import { errorText, isForbidden, type HostApi, type TemplateRecord } from '@d1/ui';
import type { GearStatus } from './useGearStatus';
import { canChange, templatesOf, warnOf, type TemplateCollection, type TemplateItem, type TemplateScope } from './templates';

const BASE = '/d1-build/templates';

/** The result of a write: the template as the server has it now, or what to tell the person. */
export type TemplateResult = { ok: true; template: TemplateRecord | null } | { ok: false; message: string };

/** What the page says when the account may not build, so may not use templates (d1-build answers 403): said once, no list is shown. */
export const NO_TEMPLATES = 'Your account may not use templates.';

const status = (e: unknown): number | undefined => (e as { response?: { status?: number } })?.response?.status;

/** What the server said, if it said anything (the Directus error shape). */
const said = (e: unknown): string => String((e as { response?: { data?: { errors?: { message?: string }[] } } })?.response?.data?.errors?.[0]?.message ?? '');

/** The 400 messages d1-build writes for people (the name, the role to share with); every other 400 names a column or a field and is for developers. */
const PLAIN_400 = /^(A name|You have no account role|A template can only be shared)/;

/**
 * The plain words for a failed write. `what` is the thing that was being done ("rename the template"). A 403 is either the build gate (this
 * account may not build processes at all) or "not yours to change": the server's own words tell them apart, and both are plain already.
 */
export function failureText(e: unknown, what: string): string {
	const s = status(e);
	const msg = said(e);
	if (s === 403 || isForbidden(e)) return /build processes/i.test(msg) ? msg : 'Only the person who made a template, or an administrator, can change it.';
	if (s === 404) return 'That template does not exist any more.';
	if (s === 409) return 'This template changed since you opened it. It has been reloaded: try again.';
	if (s === undefined || s === 0) return `Could not reach the server to ${what}.`;
	if (s === 400) return PLAIN_400.test(msg) ? msg : `Could not ${what}: the server did not accept it. If the template's method or test type was removed, replace its settings or delete it.`;
	return errorText(e, `The server refused to ${what}.`);
}

export function useTemplates(o: {
	api: HostApi;
	gear: Pick<GearStatus, 'ensure' | 'problem'>;
	me: () => { id?: string | null; admin?: boolean };
	/** Cleans a template's values when it is used (against the form's current fields): a column that is gone or a field the draft now refuses never reaches a draft. */
	clean?: (collection: TemplateCollection, values: Record<string, unknown>) => Record<string, unknown>;
}) {
	const rows = shallowRef<TemplateRecord[]>([]);
	const loaded = ref(false);
	/** d1-build said 403: this account may not build, so no templates (and no group in the palette). */
	const forbidden = ref(false);
	/** The last failure, in words; cleared by the next success or `dismiss`. */
	const error = ref('');
	const busy = ref(false);

	/** The list for the palette and the add search: with who may change each and what is wrong with the gear it names. */
	const items = computed<TemplateItem[]>(() =>
		rows.value.map((raw) => {
			const rec = o.clean ? { ...raw, values: o.clean(raw.collection, raw.values) } : raw;
			const warn = warnOf(rec.values, o.gear.problem);
			return { rec, mine: canChange(rec, o.me()), ...(warn ? { warn } : {}) };
		}),
	);

	let reading: Promise<void> | null = null;
	/** Reads the list, once; `refresh` reads it again. */
	function ensure(): Promise<void> {
		return (reading ??= refresh());
	}
	async function refresh(): Promise<void> {
		try {
			const res = await o.api.get(BASE);
			rows.value = templatesOf(res.data?.data);
			forbidden.value = false;
			void o.gear.ensure(rows.value.map((r) => r.values));
		} catch (e) {
			if (isForbidden(e)) {
				forbidden.value = true;
				rows.value = [];
			} else {
				// A list that cannot be read: the palette shows none of them. Said (once), so it is not mistaken for "no templates yet"; the next
				// `ensure` asks again.
				if (!loaded.value) error.value = `Could not read the templates: ${errorText(e, 'the server did not answer')}`;
				reading = null;
			}
		} finally {
			loaded.value = true;
		}
	}

	const put = (t: TemplateRecord): void => void (rows.value = [...rows.value.filter((r) => r.id !== t.id), t].sort((a, b) => a.name.localeCompare(b.name)));

	async function write(what: string, run: () => Promise<TemplateRecord | null>, reload = true): Promise<TemplateResult> {
		busy.value = true;
		try {
			const template = await run();
			error.value = '';
			return { ok: true, template };
		} catch (e) {
			const message = failureText(e, what);
			error.value = message;
			// A stale version or a template that is gone: what the person sees is brought up to date.
			if (reload && [404, 409].includes(status(e) ?? 0)) await refresh();
			return { ok: false, message };
		} finally {
			busy.value = false;
		}
	}
	const current = (id: string): TemplateRecord | undefined => rows.value.find((r) => r.id === id);
	const patch = (id: string, what: string, body: Record<string, unknown>): Promise<TemplateResult> =>
		write(what, async () => {
			const t = current(id);
			if (!t) throw Object.assign(new Error('gone'), { response: { status: 404 } });
			const res = await o.api.patch(`${BASE}/${encodeURIComponent(id)}`, { ...body, version: t.version });
			const [saved] = templatesOf([res.data?.data]);
			if (saved) put(saved);
			return saved ?? null;
		});

	/** Saves a new template (`values` as `templateValuesOf` made them). The scope 'role' shares it with the person's own account role. */
	const create = (b: { name: string; scope: TemplateScope; collection: TemplateCollection; values: Record<string, unknown> }): Promise<TemplateResult> =>
		write('save the template', async () => {
			const res = await o.api.post(BASE, { name: b.name, scope: b.scope, collection: b.collection, values: b.values });
			const [saved] = templatesOf([res.data?.data]);
			if (saved) {
				put(saved);
				void o.gear.ensure([saved.values]);
			}
			return saved ?? null;
		}, false);
	const rename = (id: string, name: string): Promise<TemplateResult> => patch(id, 'rename the template', { name });
	const setScope = (id: string, scope: TemplateScope): Promise<TemplateResult> => patch(id, 'change who sees the template', { scope });
	/** "Replace with the selected card's settings": the values of the template become `values`. */
	const replaceValues = (id: string, values: Record<string, unknown>): Promise<TemplateResult> => patch(id, 'replace the template', { values });
	const remove = (id: string): Promise<TemplateResult> =>
		write('delete the template', async () => {
			await o.api.delete(`${BASE}/${encodeURIComponent(id)}`);
			rows.value = rows.value.filter((r) => r.id !== id);
			return null;
		});

	const dismiss = (): void => void (error.value = '');

	return { rows, items, loaded, forbidden, error, busy, ensure, refresh, create, rename, setScope, replaceValues, remove, dismiss };
}

export type Templates = ReturnType<typeof useTemplates>;
