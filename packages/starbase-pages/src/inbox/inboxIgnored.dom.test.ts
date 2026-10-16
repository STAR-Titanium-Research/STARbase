// @vitest-environment happy-dom
// Ignored folders on the Inbox page, behaviourally, against the fake d1-inbox: "Ignore this folder" on a row and its confirm (exactly what happens), the
// notice with the server's count and Remove rule, the Ignored folders section (rules, Remove, the add field with its choices and its checks), the server's
// refusals in its own words, a team folder's rule, a Lab Viewer who cannot remove, and a server that has no such route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks, type HostApi } from '@d1/ui';
import { setPageFrame } from '../frame';
import InboxView from './InboxView.vue';
import { createFakeInbox, foundFile, type FakeInboxOptions } from './fakeInboxServer';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean, title: String },
	emits: ['click'],
	setup: (p, { slots, emit }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, title: p.title, onClick: () => emit('click') }, slots.default?.()),
});
const Div = defineComponent({ setup: (_p, { slots }) => () => h('div', slots.default?.()) });
// Esc makes Directus's v-dialog say both "esc" and "closed"; so does this stand-in
const Dialog = defineComponent({
	props: { modelValue: Boolean },
	emits: ['update:modelValue', 'esc'],
	setup: (p, { slots, emit }) => () =>
		p.modelValue
			? h('div', { role: 'dialog', tabindex: -1, onKeydown: (e: KeyboardEvent) => e.key === 'Escape' && (emit('esc'), emit('update:modelValue', false)) }, slots.default?.())
			: null,
});
function registerStubs(app: App) {
	app.component('v-button', Button);
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	app.component('v-progress-circular', defineComponent({ setup: () => () => h('span') }));
	app.component('v-dialog', Dialog);
	for (const n of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions']) app.component(n, Div);
}

const TEAM = { kind: 'team', id: '00000000-0000-4000-8000-000000000021', name: 'SEM team' } as const;
const TEAM_SUMMARY = { teams: [{ team_id: TEAM.id, name: TEAM.name, new: 1, older_matches: 0 }] };

let app: App | null = null;
let router: Router;
let fake: ReturnType<typeof createFakeInbox>;

async function mount(files = defaultFiles(), opts: FakeInboxOptions = {}, url = '/inbox') {
	fake = createFakeInbox({ files, ...opts });
	setExplorerHostFactory(() => ({
		api: fake.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	configureLinks(starbaseLinks('https://d1.example'));
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
	router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }] });
	await router.push(url);
	app = createApp({ render: () => h('div', [h(RouterView)]) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('nav[aria-label="Inbox tabs"]')).not.toBeNull());
	await vi.waitFor(() => expect(document.querySelector('.d1-state')).toBeNull());
	await vi.waitFor(() => expect(fake.calls.some((c) => c.path === '/d1-inbox/ignored-folders')).toBe(true));
	await flush();
}

const defaultFiles = () => [
	foundFile({ rel_path: 'Users/ab1cd/Paper/Drafts/a.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/paper/b.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/Paper 2/c.tif' }),
	foundFile({ rel_path: 'Users/ab1cd/root.tif' }),
];

const flush = async () => {
	for (let i = 0; i < 5; i += 1) {
		await Promise.resolve();
		await nextTick();
	}
};
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-test="inbox-row"]')];
const names = () => rows().map((r) => r.querySelector('.name')?.textContent);
const rowOf = (name: string) => rows().find((r) => r.textContent?.includes(name))!;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = (el: Element | null | undefined) => (el as HTMLElement).click();
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const notice = () => q('[data-test="notice"]');
const posts = () => fake.calls.filter((c) => c.method === 'post' && c.path === '/d1-inbox/ignored-folders');
async function typeInto(el: HTMLInputElement, value: string) {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	await nextTick();
}
const openSection = async () => {
	click(q('[data-test="ignored-toggle"]'));
	await nextTick();
};

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	resetLinks();
	setExplorerHostFactory(null);
});

describe('Ignore this folder on a row', () => {
	it('is offered beside the folder of an open file, and not for a file directly in the share folder', async () => {
		await mount();
		expect(rowOf('a.tif').querySelector('[data-test="ignore-folder"]')?.textContent).toBe('Ignore this folder');
		expect(rowOf('root.tif').querySelector('[data-test="ignore-folder"]')).toBeNull();
	});

	it('is not offered on the Dismissed tab', async () => {
		await mount(defaultFiles().map((f) => ({ ...f, state: 'dismissed' as const })), {}, '/inbox?tab=dismissed');
		expect(rows().length).toBeGreaterThan(0);
		expect(document.querySelector('[data-test="ignore-folder"]')).toBeNull();
	});

	it('opens a confirm that says exactly what happens, names the folder relative to the person\'s own folder, and Cancel sends nothing', async () => {
		await mount();
		click(rowOf('a.tif').querySelector('[data-test="ignore-folder"]'));
		await nextTick();
		expect(q('[data-test="ignore-title"]')?.textContent).toBe('Stop scanning Paper/Drafts?');
		const lines = [...document.querySelectorAll('[data-test="ignore-line"]')].map((l) => l.textContent);
		expect(lines).toEqual([
			'The crawler stops looking for new files in Paper/Drafts and below.',
			'Files there that are still in your Inbox (1 found file shown here) move to Dismissed. You can restore them.',
			'Files already linked stay linked and tracked. Nothing on the share is changed.',
		]);
		expect(q('[data-test="ignore-team"]')).toBeNull();
		click(q('[data-test="ignore-cancel"]'));
		await nextTick();
		expect(dialog()).toBeNull();
		expect(posts()).toEqual([]);
		expect(names()).toHaveLength(4);
	});

	it('Cancel gives focus back to the row\'s Ignore this folder button, and so does Esc', async () => {
		await mount();
		const button = rowOf('a.tif').querySelector<HTMLElement>('[data-test="ignore-folder"]')!;
		button.focus();
		click(button);
		await nextTick();
		// the dialog took focus away from the button (a real one moves it inside the card)
		button.blur();
		expect(document.activeElement).not.toBe(button);
		click(q('[data-test="ignore-cancel"]'));
		await flush();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(button);
		// the other row's button, then Esc
		const other = rowOf('b.tif').querySelector<HTMLElement>('[data-test="ignore-folder"]')!;
		click(other);
		await nextTick();
		other.blur();
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flush();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(other);
		expect(posts()).toEqual([]);
	});

	it('after Stop scanning the row is gone, so focus goes to the status line that says what happened', async () => {
		await mount();
		const button = rowOf('a.tif').querySelector<HTMLElement>('[data-test="ignore-folder"]')!;
		click(button);
		await nextTick();
		click(q('[data-test="ignore-confirm"]'));
		await vi.waitFor(() => expect(notice()?.textContent).toContain('Ignoring Paper/Drafts.'));
		await vi.waitFor(() => expect(button.isConnected).toBe(false));
		await flush();
		expect(document.activeElement).toBe(q('[data-test="status"]'));
	});

	it('Stop scanning adds the rule, the files below it leave New, the badge count drops, and the notice says the server\'s count with Remove rule', async () => {
		await mount();
		expect(q('[data-test="tab-new"] .n')?.textContent).toBe('4');
		click(rowOf('b.tif').querySelector('[data-test="ignore-folder"]'));
		await nextTick();
		expect(q('[data-test="ignore-title"]')?.textContent).toBe('Stop scanning paper?');
		click(q('[data-test="ignore-confirm"]'));
		await vi.waitFor(() => expect(notice()?.textContent).toContain('Ignoring paper.'));
		expect(posts().map((c) => c.body)).toEqual([{ folder: 'paper' }]);
		expect(notice()?.textContent).toContain('2 found files moved to Dismissed.');
		expect(q('[data-test="remove-rule"]')?.textContent).toBe('Remove rule');
		// "Paper 2" is a different folder; the file directly in the share folder is not below it
		await vi.waitFor(() => expect(names()).toEqual(['c.tif', 'root.tif']));
		await vi.waitFor(() => expect(q('[data-test="tab-new"] .n')?.textContent).toBe('2'));
		expect(dialog()).toBeNull();
		// the files are in Dismissed, where Restore brings them back
		await router.replace({ path: '/inbox', query: { tab: 'dismissed' } });
		await vi.waitFor(() => expect(names()).toEqual(['a.tif', 'b.tif']));
	});

	it('Remove rule in the notice removes that rule, says a rescan is coming, and leaves the dismissed files where they are', async () => {
		await mount();
		click(rowOf('a.tif').querySelector('[data-test="ignore-folder"]'));
		await nextTick();
		click(q('[data-test="ignore-confirm"]'));
		await vi.waitFor(() => expect(q('[data-test="remove-rule"]')).not.toBeNull());
		click(q('[data-test="remove-rule"]'));
		await vi.waitFor(() => expect(notice()?.textContent).toContain('Stopped ignoring Paper/Drafts.'));
		expect(notice()?.textContent).toContain('A rescan is queued');
		expect(q('[data-test="remove-rule"]')).toBeNull();
		expect(fake.rules).toEqual([]);
		expect(fake.files.filter((f) => f.state === 'dismissed')).toHaveLength(1);
		expect(names()).toEqual(['b.tif', 'c.tif', 'root.tif']);
	});

	it('a refusal is shown in the dialog in the server\'s words and the dialog stays open', async () => {
		await mount(defaultFiles(), { ignoredRules: [{ folder: 'paper/drafts' }] });
		click(rowOf('a.tif').querySelector('[data-test="ignore-folder"]'));
		await nextTick();
		click(q('[data-test="ignore-confirm"]'));
		await vi.waitFor(() => expect(q('[data-test="ignore-error"]')?.textContent).toBe('That folder is already ignored.'));
		expect(dialog()).not.toBeNull();
		expect(notice()).toBeNull();
		expect(names()).toHaveLength(4);
	});

	it('a file in a team folder makes the rule the team\'s, and the confirm says so', async () => {
		await mount([...defaultFiles(), foundFile({ rel_path: 'Shared/SEM/Old runs/d.tif', owner: TEAM })], { summary: TEAM_SUMMARY });
		click(rowOf('d.tif').querySelector('[data-test="ignore-folder"]'));
		await nextTick();
		expect(q('[data-test="ignore-title"]')?.textContent).toBe('Stop scanning Old runs?');
		expect(q('[data-test="ignore-team"]')?.textContent).toContain('SEM team');
		click(q('[data-test="ignore-confirm"]'));
		await vi.waitFor(() => expect(notice()?.textContent).toContain('Ignoring Old runs. 1 found file moved to Dismissed.'));
		expect(posts().map((c) => c.body)).toEqual([{ folder: 'Old runs', team_id: TEAM.id }]);
		expect(names()).toHaveLength(4);
	});
});

describe('the Ignored folders section', () => {
	it('is one quiet line while closed, and says there are none when opened and empty', async () => {
		await mount();
		const toggle = q('[data-test="ignored-toggle"]')!;
		expect(toggle.textContent?.trim()).toBe('Show ignored folders');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(q('[data-test="ignored-list"]')).toBeNull();
		await openSection();
		expect(q('[data-test="ignored-toggle"]')?.getAttribute('aria-expanded')).toBe('true');
		expect(q('[data-test="ignored-empty"]')?.textContent).toBe('No folders are ignored.');
		await openSection();
		expect(q('[data-test="ignored-empty"]')).toBeNull();
	});

	it('lists each rule, counts them in the toggle, and names the owner only when the person has a team folder', async () => {
		await mount(defaultFiles(), { ignoredRules: [{ folder: 'Old runs', owner: TEAM }, { folder: 'World-Ti Paper/Drafts' }], ignoreTeams: [{ team_id: TEAM.id, name: TEAM.name, share_folder: 'SEM' }], summary: TEAM_SUMMARY });
		expect(q('[data-test="ignored-toggle"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Show ignored folders (2)');
		await openSection();
		const list = [...document.querySelectorAll('[data-test="ignored-rule"]')].map((li) => [li.querySelector('[data-test="ignored-folder"]')?.textContent, li.querySelector('[data-test="ignored-owner"]')?.textContent]);
		expect(list).toEqual([['Old runs', 'SEM team (team folder)'], ['World-Ti Paper/Drafts', 'Ann Lee']]);
		// the owner menu of the add field offers the person's own folder and the team's
		expect([...document.querySelectorAll('[data-test="ignored-owner-select"] option')].map((o) => o.textContent)).toEqual(['My folder', 'SEM team team folder']);
	});

	it('without a team folder the rules do not name their owner and there is no owner menu', async () => {
		await mount(defaultFiles(), { ignoredRules: [{ folder: 'Drafts' }] });
		await openSection();
		expect(q('[data-test="ignored-owner"]')).toBeNull();
		expect(q('[data-test="ignored-owner-select"]')).toBeNull();
	});

	it('Remove deletes the rule, says so, and lists the folder again at the next scan', async () => {
		await mount(defaultFiles(), { ignoredRules: [{ folder: 'Drafts' }] });
		await openSection();
		click(q('[data-test="ignored-remove"]'));
		await vi.waitFor(() => expect(notice()?.textContent).toContain('Stopped ignoring Drafts.'));
		await vi.waitFor(() => expect(q('[data-test="ignored-empty"]')).not.toBeNull());
		expect(fake.rules).toEqual([]);
		expect(fake.calls.some((c) => c.method === 'delete' && c.path.startsWith('/d1-inbox/ignored-folders/'))).toBe(true);
	});

	it('Remove of a rule that another rule still covers says so and names it, with no word of a rescan', async () => {
		await mount(defaultFiles(), { ignoredRules: [{ folder: 'Paper' }, { folder: 'Paper/Drafts' }] });
		await openSection();
		const li = [...document.querySelectorAll('[data-test="ignored-rule"]')].find((x) => x.querySelector('[data-test="ignored-folder"]')?.textContent === 'Paper/Drafts')!;
		click(li.querySelector('[data-test="ignored-remove"]'));
		await vi.waitFor(() => expect(notice()?.textContent).toContain('Rule removed. Paper/Drafts is still ignored by another rule (Paper).'));
		expect(notice()?.textContent).not.toMatch(/rescan|next scan|listed again/i);
		await vi.waitFor(() => expect(document.querySelectorAll('[data-test="ignored-rule"]')).toHaveLength(1));
	});

	it('a failed Remove says why in the section', async () => {
		await mount(defaultFiles(), { ignoredRules: [{ folder: 'Drafts' }] });
		await openSection();
		fake.rules.length = 0; // gone on the server since the list was read
		click(q('[data-test="ignored-remove"]'));
		await vi.waitFor(() => expect(q('[data-test="ignored-error"]')?.textContent).toBe('That ignored folder does not exist.'));
	});

	it('the add field offers the folders of the files on screen (and the ones above them), minus those already ignored', async () => {
		await mount(defaultFiles(), { ignoredRules: [{ folder: 'Paper 2' }] });
		await openSection();
		const options = [...document.querySelectorAll('#ignored-choices option')].map((o) => (o as HTMLOptionElement).value);
		expect(options).toEqual(['Paper', 'Paper/Drafts']);
	});

	it('typing a folder and pressing Ignore folder adds it, reloads the list and empties the field', async () => {
		await mount();
		await openSection();
		const input = q('[data-test="ignored-input"]') as HTMLInputElement;
		expect((q('[data-test="ignored-add"]') as HTMLButtonElement).disabled).toBe(true);
		await typeInto(input, 'Paper/Drafts');
		click(q('[data-test="ignored-add"]'));
		await vi.waitFor(() => expect(notice()?.textContent).toContain('Ignoring Paper/Drafts. 1 found file moved to Dismissed.'));
		expect(posts().map((c) => c.body)).toEqual([{ folder: 'Paper/Drafts' }]);
		await vi.waitFor(() => expect(document.querySelectorAll('[data-test="ignored-rule"]')).toHaveLength(1));
		expect(input.value).toBe('');
		await vi.waitFor(() => expect(names()).toEqual(['b.tif', 'c.tif', 'root.tif']));
	});

	it('checks a typed folder the way the server does, before sending anything', async () => {
		await mount();
		await openSection();
		const input = q('[data-test="ignored-input"]') as HTMLInputElement;
		const cases: Array<[string, string]> = [
			['/Paper', 'The folder must not start or end with a slash.'],
			['Paper/', 'The folder must not start or end with a slash.'],
			['Paper//Drafts', 'The folder has an empty part (two slashes in a row).'],
			['Paper/../x', 'The folder must not contain . or .. parts.'],
			['Paper\\Drafts', 'Write the folder with / between the names, not \\.'],
		];
		for (const [value, said] of cases) {
			await typeInto(input, value);
			click(q('[data-test="ignored-add"]'));
			await vi.waitFor(() => expect(q('[data-test="ignored-problem"]')?.textContent, value).toBe(said));
		}
		expect(posts()).toEqual([]);
		expect(input.value).toBe('Paper\\Drafts');
	});

	it('shows the server\'s own words when it refuses a typed folder (a path that starts with the person\'s folder)', async () => {
		await mount();
		await openSection();
		await typeInto(q('[data-test="ignored-input"]') as HTMLInputElement, 'Users/ab1cd/Paper');
		click(q('[data-test="ignored-add"]'));
		await vi.waitFor(() => expect(q('[data-test="ignored-problem"]')?.textContent).toBe('Give the folder relative to your own folder, without Users/ab1cd/.'));
		expect(posts()).toHaveLength(1);
		expect(fake.rules).toEqual([]);
	});

	it('adds a rule for a team folder when the owner menu says so', async () => {
		await mount([...defaultFiles(), foundFile({ rel_path: 'Shared/SEM/Old runs/d.tif', owner: TEAM })], { summary: TEAM_SUMMARY });
		await openSection();
		const select = q('[data-test="ignored-owner-select"]') as HTMLSelectElement;
		select.value = `team:${TEAM.id}`;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await nextTick();
		expect([...document.querySelectorAll('#ignored-choices option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['Old runs']);
		await typeInto(q('[data-test="ignored-input"]') as HTMLInputElement, 'Old runs');
		click(q('[data-test="ignored-add"]'));
		await vi.waitFor(() => expect(posts().map((c) => c.body)).toEqual([{ folder: 'Old runs', team_id: TEAM.id }]));
	});
});

describe('a Lab Viewer and an older server', () => {
	it('a Lab Viewer sees the rules with Remove off and the reason, no add field, and no Ignore this folder on a row', async () => {
		await mount(defaultFiles(), { viewer: true, ignoredRules: [{ folder: 'Drafts' }] });
		expect(document.querySelector('[data-test="ignore-folder"]')).toBeNull();
		await openSection();
		const remove = q('[data-test="ignored-remove"]') as HTMLButtonElement;
		expect(remove.disabled).toBe(true);
		expect(remove.title).toBe('You can see these rules but not change them.');
		expect(q('[data-test="ignored-readonly"]')?.textContent).toBe('You can see these rules but not change them.');
		expect(q('[data-test="ignored-input"]')).toBeNull();
		click(remove);
		expect(fake.calls.some((c) => c.method === 'delete')).toBe(false);
	});

	it('a Lab Viewer with NO rules gets no Ignore this folder on any row and no add field, and is told why', async () => {
		await mount(defaultFiles(), { viewer: true });
		expect(rows().length).toBeGreaterThan(0);
		expect(document.querySelector('[data-test="ignore-folder"]')).toBeNull();
		await openSection();
		expect(q('[data-test="ignored-empty"]')?.textContent).toBe('No folders are ignored.');
		expect(q('[data-test="ignored-readonly"]')?.textContent).toBe('You can see these rules but not change them.');
		expect(q('[data-test="ignored-input"]')).toBeNull();
		expect(q('[data-test="ignored-add"]')).toBeNull();
		expect(fake.calls.some((c) => c.method === 'post')).toBe(false);
	});

	it('an older server with no meta: a viewer with rules is still read-only, a person with no rules still may ignore', async () => {
		await mount(defaultFiles(), { viewer: true, noMeta: true, ignoredRules: [{ folder: 'Drafts' }] });
		expect(document.querySelector('[data-test="ignore-folder"]')).toBeNull();
		app?.unmount();
		document.body.innerHTML = '';
		await mount(defaultFiles(), { noMeta: true });
		expect(rowOf('a.tif').querySelector('[data-test="ignore-folder"]')).not.toBeNull();
	});

	it('a server with no ignored-folders route shows nothing about it', async () => {
		const files = defaultFiles();
		fake = createFakeInbox({ files });
		const api: HostApi = { ...fake.api, get: (path, config) => (path === '/d1-inbox/ignored-folders' ? Promise.reject(Object.assign(new Error('nope'), { response: { status: 404, data: { errors: [{ message: 'no route', extensions: { code: 'ROUTE_NOT_FOUND' } }] } } })) : fake.api.get(path, config)) };
		setExplorerHostFactory(() => ({
			api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
		}));
		configureLinks(starbaseLinks('https://d1.example'));
		setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', [slots.default?.()]) }));
		router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/inbox', component: InboxView }] });
		await router.push('/inbox');
		app = createApp({ render: () => h('div', [h(RouterView)]) });
		app.use(router);
		registerStubs(app);
		const el = document.createElement('div');
		document.body.appendChild(el);
		app.mount(el);
		await vi.waitFor(() => expect(rows().length).toBe(4));
		await flush();
		expect(q('[data-test="ignored"]')).toBeNull();
		expect(document.querySelector('[data-test="ignore-folder"]')).toBeNull();
	});
});
