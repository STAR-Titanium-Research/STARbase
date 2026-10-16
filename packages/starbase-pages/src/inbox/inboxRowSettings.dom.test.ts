// @vitest-environment happy-dom
// An Inbox row for an SEM image: its imaging settings as labelled values with their source, "check this" where nothing could vouch for a value,
// "couldn't read <field>" where one failed, the time as UK time; a row with nothing read shows nothing extra; an older row keeps its one line.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { setExplorerHostFactory } from '@d1/ui';
import InboxRow from './InboxRow.vue';
import { createFakeInbox, foundFile } from './fakeInboxServer';
import type { FoundFile } from './inboxApi';

let app: App | null = null;
function mount(file: FoundFile): HTMLElement {
	// the row asks the Explorer host for its api (the thumbnail, since the Inbox pictures work); these rows have no picture, so it is never called
	const { api } = createFakeInbox({ files: [file] });
	setExplorerHostFactory(() => ({
		api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	app = createApp({ render: () => h(InboxRow, { file, busy: false, tab: 'new', showOwner: false }) });
	app.component('v-button', defineComponent({ setup: (_p, { slots }) => () => h('button', slots.default?.()) }));
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	return el;
}
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	document.body.innerHTML = '';
});

const NEW_ROW = {
	kv: 15, spot: 3, working_distance_mm: 8.5, magnification: 5000, hfw_um: 59.7, scale_bar_um: 10, detector: 'ETD', mode: 'SE', instrument: 'Quanta 650',
	acquired_at: '2026-07-01T09:05:00+00:00',
	sources: { kv: 'metadata', spot: 'metadata', working_distance_mm: 'metadata', magnification: 'derived', hfw_um: 'metadata', scale_bar_um: 'ocr', detector: 'ocr', mode: 'ocr', instrument: 'metadata', acquired_at: 'metadata' },
	flags: { check_this: true },
	ocr_confidence: { scale_bar_um: 0.61, detector: 0.7 },
};
const field = (el: HTMLElement, key: string) => el.querySelector<HTMLElement>(`[data-field="${key}"]`);

describe('the imaging settings in an Inbox row', () => {
	it('lists labelled values with units, in order, each with its source', () => {
		const el = mount(foundFile({ kind: 'sem_image', extracted: NEW_ROW }));
		const labels = [...el.querySelectorAll('[data-field] dt')].map((d) => d.textContent);
		expect(labels.slice(0, 8)).toEqual(['kV', 'working distance', 'magnification', 'spot', 'detector', 'mode', 'scale bar', 'taken']);
		expect(field(el, 'kv')!.textContent).toContain('15 kV');
		expect(field(el, 'kv')!.querySelector('[data-test="setting-source"]')!.textContent).toBe('metadata');
		expect(field(el, 'working_distance_mm')!.textContent).toContain('8.5 mm');
		expect(field(el, 'magnification')!.textContent).toContain('×5,000');
		expect(field(el, 'magnification')!.querySelector('[data-test="setting-source"]')!.textContent).toBe('derived');
		expect(field(el, 'scale_bar_um')!.textContent).toContain('10 µm');
		expect(field(el, 'detector')!.querySelector('[data-test="setting-source"]')!.textContent).toBe('OCR');
	});

	it('shows the time as UK time with BST or GMT', () => {
		const el = mount(foundFile({ kind: 'sem_image', extracted: NEW_ROW }));
		expect(field(el, 'acquired_at')!.textContent).toContain('1 Jul 2026, 10:05 BST');
	});

	it('marks "check this" on what the bar alone vouched for, and not on a value metadata gave', () => {
		const el = mount(foundFile({ kind: 'sem_image', extracted: NEW_ROW }));
		expect(field(el, 'scale_bar_um')!.querySelector('[data-test="setting-check"]')!.textContent).toBe('check this');
		expect(field(el, 'kv')!.querySelector('[data-test="setting-check"]')).toBeNull();
	});

	it('says "couldn\'t read <field>" for a failed field, with no value', () => {
		const el = mount(foundFile({ kind: 'sem_image', extracted: { kv: 15, sources: { kv: 'ocr' }, flags: { magnification: 'hfw_mismatch' } } }));
		const f = field(el, 'magnification')!;
		expect(f.querySelector('[data-test="setting-failed"]')!.textContent).toContain("couldn't read magnification");
		expect(f.querySelector('[data-test="setting-value"]')).toBeNull();
	});

	it('never shows OCR confidence', () => {
		const el = mount(foundFile({ kind: 'sem_image', extracted: NEW_ROW }));
		expect(el.textContent).not.toMatch(/0\.61|0\.7\b|confidence/i);
	});

	it('shows nothing extra for a row with no extracted keys', () => {
		const el = mount(foundFile({ kind: 'sem_image', extracted: {} }));
		expect(el.querySelector('[data-test="sem-settings"]')).toBeNull();
		expect(el.querySelector('.read')).toBeNull();
	});

	it('keeps the one line for an older row with no sources (the legacy text scale bar included)', () => {
		const el = mount(foundFile({ kind: 'sem_image', extracted: { kv: 15, magnification: 5000, scale_bar: '2 µm', instrument: 'JEOL' } }));
		expect(el.querySelector('[data-test="sem-settings"]')).toBeNull();
		expect(el.querySelector('.read')!.textContent).toBe('15 kV · ×5,000 · 2 µm · JEOL');
	});
});
