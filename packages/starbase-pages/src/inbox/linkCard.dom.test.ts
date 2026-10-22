// @vitest-environment happy-dom
// The Link card and the strip of siblings on their own (linkedModel.ts says the words; these are the parts a person presses): what the card shows, Open / Change /
// Undo as events, the Undo confirm (focus, Esc, the batch it names), nothing for an unlinked file, and the strip's pictures, "+N" and "Compare with…".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App, type Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, setExplorerHostFactory, starbaseLinks } from '@d1/ui';
import LinkCard from './LinkCard.vue';
import LinkedSiblings from './LinkedSiblings.vue';
import { createFakeInbox, foundFile } from './fakeInboxServer';
import type { FoundFile } from './inboxApi';

const REC = '00000000-0000-4000-8000-000000000101';
const linked = (over: Partial<FoundFile> = {}): FoundFile =>
	foundFile({
		kind: 'sem_image', has_thumbnail: true, state: 'linked', link_kind: 'manual', link_batch_id: 'b1', link_batch_size: 1, decided_at: '2026-10-22T14:05:00.000Z', decided_by_name: 'Alice A',
		linked_collection: 'physical_samples', linked_record_id: REC, linked_label: 'S-0042', linked_title: 'Ti-6Al-4V fatigue bar', ...over,
	});

let app: App | null = null;
function mount(component: Component, props: Record<string, unknown>, on: Record<string, (...a: any[]) => void> = {}, files: FoundFile[] = []) {
	const fake = createFakeInbox({ files });
	setExplorerHostFactory(() => ({
		api: fake.api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	configureLinks(starbaseLinks('https://d1.example'));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
	const state = ref(props);
	const handlers = Object.fromEntries(Object.entries(on).map(([k, fn]) => [`on${k[0].toUpperCase()}${k.slice(1)}`, fn]));
	app = createApp({ render: () => h(component, { ...state.value, ...handlers }) });
	app.use(router);
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('span', { class: 'icon', 'data-icon': p.name }) }));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	return { el, set: (p: Record<string, unknown>) => (state.value = { ...state.value, ...p }) };
}
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = (sel: string) => q<HTMLButtonElement>(sel)!.click();

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	resetLinks();
	setExplorerHostFactory(null);
	vi.restoreAllMocks();
});

describe('LinkCard', () => {
	it('names the record (a mono link), its title, who linked it, how and when; Open, Change and Undo are the buttons', () => {
		mount(LinkCard, { file: linked(), busy: false });
		expect(q('[data-test="link-head"]')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('Linked to S-0042');
		expect(q('[data-test="link-code"]')!.tagName).toBe('A');
		expect(q('[data-test="link-code"]')!.getAttribute('href')).toBe('/samples/' + REC);
		expect(q('[data-test="link-meta"]')!.textContent).toBe('Ti-6Al-4V fatigue bar · by Alice A · manually · 22 Oct 2026');
		expect(q('[data-test="link-open"]')!.textContent).toBe('Open sample');
		expect(q('[data-test="link-change"]')!.textContent).toBe('Change…');
		expect(q('[data-test="link-undo"]')!.textContent).toBe('Undo link');
	});

	it('says an operation and a test in their own words', () => {
		mount(LinkCard, { file: linked({ linked_collection: 'manufacturing_operations', linked_label: 'OP-0188', linked_title: null, link_kind: 'auto' }), busy: false });
		expect(q('[data-test="link-code"]')!.textContent).toBe('OP-0188');
		expect(q('[data-test="link-open"]')!.textContent).toBe('Open operation');
		expect(q('[data-test="link-meta"]')!.textContent).toBe('by Alice A · automatically · 22 Oct 2026');
	});

	it('a surface scan was added, not linked: Open goes to the edge, and there is no Change', () => {
		mount(LinkCard, { file: linked({ kind: 'surface_scan', linked_collection: 'surface_scans', linked_record_id: 's1', linked_label: 'H13A-#2-fC (worn)', linked_edge_id: 'e1', linked_title: null }), busy: false });
		expect(q('[data-test="link-head"]')!.textContent).toContain('Added as a surface scan of');
		expect(q('[data-test="link-open"]')!.textContent).toBe('Open edge');
		expect(q('[data-test="link-change"]')).toBeNull();
		expect(q('[data-test="link-undo"]')).not.toBeNull();
	});

	it('a record the caller cannot read is not named and has no Open', () => {
		mount(LinkCard, { file: linked({ linked_collection: null, linked_record_id: null, linked_label: null, linked_title: null }), busy: false });
		expect(q('[data-test="link-code"]')!.textContent).toBe('a record you cannot open');
		expect(q('[data-test="link-code"]')!.tagName).toBe('SPAN');
		expect(q('[data-test="link-open"]')).toBeNull();
	});

	it('shows nothing for a file that is not linked', () => {
		mount(LinkCard, { file: foundFile(), busy: false });
		expect(q('[data-test="link-card"]')).toBeNull();
		expect(document.body.textContent!.trim()).toBe('');
	});

	it('Open sends the record\'s page, Change asks for the Link dialog', () => {
		const open = vi.fn();
		const change = vi.fn();
		mount(LinkCard, { file: linked(), busy: false }, { open, change });
		click('[data-test="link-open"]');
		expect(open).toHaveBeenCalledWith('/home/samples/' + REC);
		click('[data-test="link-change"]');
		expect(change).toHaveBeenCalledTimes(1);
	});

	it('Undo link asks first: the confirm is a group in a live region, Cancel has the focus, and only the confirm undoes', async () => {
		const undo = vi.fn();
		mount(LinkCard, { file: linked(), busy: false }, { undo });
		expect(q('[aria-live="polite"]')).not.toBeNull();
		click('[data-test="link-undo"]');
		await nextTick();
		await nextTick();
		const group = q('[data-test="link-confirm"]')!;
		expect(group.getAttribute('role')).toBe('group');
		expect(group.textContent).toContain('The file goes back to your Inbox.');
		expect(document.activeElement).toBe(q('[data-test="link-undo-cancel"]'));
		expect(q('[data-test="link-undo-yes"]')!.classList.contains('danger')).toBe(true);
		expect(undo).not.toHaveBeenCalled();
		click('[data-test="link-undo-yes"]');
		expect(undo).toHaveBeenCalledTimes(1);
	});

	it('Cancel closes the confirm and gives the focus back to Undo link; Esc does the same and goes no further', async () => {
		const undo = vi.fn();
		const outer = vi.fn();
		document.addEventListener('keydown', outer);
		mount(LinkCard, { file: linked(), busy: false }, { undo });
		click('[data-test="link-undo"]');
		await nextTick();
		click('[data-test="link-undo-cancel"]');
		await nextTick();
		await nextTick();
		expect(q('[data-test="link-confirm"]')).toBeNull();
		expect(document.activeElement).toBe(q('[data-test="link-undo"]'));
		click('[data-test="link-undo"]');
		await nextTick();
		q('[data-test="link-undo-cancel"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await nextTick();
		await nextTick();
		expect(q('[data-test="link-confirm"]')).toBeNull();
		expect(document.activeElement).toBe(q('[data-test="link-undo"]'));
		expect(outer).not.toHaveBeenCalled();
		expect(undo).not.toHaveBeenCalled();
		document.removeEventListener('keydown', outer);
	});

	it('names the files an undo takes with it, and offers no Change for a batch of more than one (with the reason)', async () => {
		mount(LinkCard, { file: linked({ link_kind: 'bulk', link_batch_size: 4 }), busy: false });
		expect(q<HTMLButtonElement>('[data-test="link-change"]')!.disabled).toBe(true);
		expect(q('[data-test="link-change-why"]')!.textContent).toBe('This file was linked together with 3 others. Undo that link first to link this one elsewhere.');
		expect(q('[data-test="link-change"]')!.getAttribute('aria-describedby')).toBe('link-change-why');
		click('[data-test="link-undo"]');
		await nextTick();
		expect(q('[data-test="link-confirm"]')!.textContent).toContain('This undoes the link of all 4 files linked together.');
	});

	it('is pressed once: nothing is enabled while a change or an undo runs, and the confirm closes when it ends', async () => {
		const view = mount(LinkCard, { file: linked(), busy: false });
		click('[data-test="link-undo"]');
		await nextTick();
		view.set({ busy: true });
		await nextTick();
		for (const t of ['link-change', 'link-undo-yes']) expect(q<HTMLButtonElement>(`[data-test="${t}"]`)!.disabled, t).toBe(true);
		view.set({ busy: false });
		await nextTick();
		await nextTick();
		expect(q('[data-test="link-confirm"]')).toBeNull();
	});
});

describe('LinkedSiblings', () => {
	const others = (n: number) => Array.from({ length: n }, (_, i) => linked({ rel_path: `Users/ab1cd/sem/sib${i}.tif` }));
	const self = () => linked({ rel_path: 'Users/ab1cd/sem/self.tif' });

	it('says the record and how many pictures it holds, draws the others and counts the rest', async () => {
		const rows = others(6);
		mount(LinkedSiblings, { file: self(), rows, total: 8 }, {}, rows);
		expect(q('[data-test="siblings-head"]')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('Linked to S-0042 · 9 images');
		expect(document.querySelectorAll('[data-test="sibling"]')).toHaveLength(6);
		expect(q('[data-test="siblings-more"]')!.textContent).toBe('+2');
		await vi.waitFor(() => expect(document.querySelectorAll('[data-test="sibling"] img')).toHaveLength(6));
		expect(q('[data-test="sibling"] img')!.getAttribute('src')).toMatch(/^blob:/);
	});

	it('has no "+N" when every other picture is drawn', () => {
		mount(LinkedSiblings, { file: self(), rows: others(2), total: 2 });
		expect(document.querySelectorAll('[data-test="sibling"]')).toHaveLength(2);
		expect(q('[data-test="siblings-more"]')).toBeNull();
		expect(q('[data-test="siblings-count"]')!.textContent).toBe('· 3 images');
	});

	it('shows nothing when the record has no other picture', () => {
		mount(LinkedSiblings, { file: self(), rows: [], total: 0 });
		expect(q('[data-test="siblings"]')).toBeNull();
	});

	it('a click on a picture opens it', () => {
		const open = vi.fn();
		const compare = vi.fn();
		const rows = others(3);
		mount(LinkedSiblings, { file: self(), rows, total: 3 }, { open, compare });
		document.querySelectorAll<HTMLButtonElement>('[data-test="sibling"]')[1].click();
		expect(open).toHaveBeenCalledWith(rows[1].candidate_id);
		expect(compare).not.toHaveBeenCalled();
	});

	it('"Compare with…" makes the next click start Compare instead, once; Esc leaves it', async () => {
		const open = vi.fn();
		const compare = vi.fn();
		const rows = others(3);
		mount(LinkedSiblings, { file: self(), rows, total: 3 }, { open, compare });
		const button = q<HTMLButtonElement>('[data-test="siblings-compare"]')!;
		expect(button.getAttribute('aria-pressed')).toBe('false');
		button.click();
		await nextTick();
		expect(button.getAttribute('aria-pressed')).toBe('true');
		expect(q('[data-test="siblings-hint"]')).not.toBeNull();
		expect(document.querySelector('[data-test="sibling"]')!.getAttribute('aria-label')).toMatch(/^Compare with /);
		document.querySelectorAll<HTMLButtonElement>('[data-test="sibling"]')[2].click();
		await nextTick();
		expect(compare).toHaveBeenCalledWith(rows[2].candidate_id);
		expect(open).not.toHaveBeenCalled();
		expect(button.getAttribute('aria-pressed')).toBe('false');
		// a second choosing, left with Esc, starts nothing
		button.click();
		await nextTick();
		q('[data-test="siblings"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await nextTick();
		expect(button.getAttribute('aria-pressed')).toBe('false');
		document.querySelectorAll<HTMLButtonElement>('[data-test="sibling"]')[0].click();
		expect(open).toHaveBeenCalledWith(rows[0].candidate_id);
	});

	it('a picture that is not made yet shows the icon of its kind, never a broken image', () => {
		mount(LinkedSiblings, { file: self(), rows: [linked({ has_thumbnail: false })], total: 1 });
		expect(q('[data-test="sibling"] img')).toBeNull();
		expect(q('[data-test="sibling"] .icon')).not.toBeNull();
	});
});
