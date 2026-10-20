// @vitest-environment happy-dom
// The record page's View rail in a DOM: its three settings reach the panels (two stacks, table density, empty sections hidden and counted
// under "On this page"), are remembered per kind of record, and the rail comes back as it was left.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { DataTable, PageContents, RecordLayout, RecordViewRail, Section, provideRecordView } from '@d1/ui';

let app: App | null = null;
let host: HTMLElement;

const CONTENTS = [
	{ id: 'ops', title: 'Operations', count: 2 },
	{ id: 'tests', title: 'Tests', count: 0 },
	{ id: 'files', title: 'Files', count: 0 },
];

async function mount() {
	const Page = defineComponent({
		setup() {
			provideRecordView('sample');
			return () =>
				h(RecordLayout, null, {
					rail: () => h(PageContents, { entries: CONTENTS }),
					view: () => h(RecordViewRail, { kind: 'sample' }),
					default: () => [
						h(Section, { id: 'ops', title: 'Operations', count: 2 }, () => h(DataTable, null, () => h('tr', [h('td', 'row')]))),
						h(Section, { id: 'tests', title: 'Tests', count: 0, empty: true }),
						h(Section, { id: 'files', title: 'Files', count: 0, empty: true }),
					],
				});
		},
	});
	app = createApp(Page);
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('i', p.name) }));
	app.mount(host);
	await nextTick();
}

const radio = (group: string, label: string) =>
	[...host.querySelectorAll(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)].find((b) => b.textContent === label) as HTMLElement;
async function choose(group: string, label: string) {
	radio(group, label).click();
	await nextTick();
}
const sections = () => [...host.querySelectorAll('.main section h2')].map((e) => e.textContent);

beforeEach(() => {
	window.innerWidth = 1600;
	localStorage.clear();
	// the rail starts collapsed on record pages; open it
	localStorage.setItem('d1.view.sample.open', '1');
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	app?.unmount();
	app = null;
	host.remove();
});

describe('record page View rail', () => {
	it('offers panels, table density and empty sections, with a footnote saying where they are saved', async () => {
		await mount();
		expect([...host.querySelectorAll('.d1-view-section .label')].map((e) => e.textContent)).toEqual(['Panels', 'Table density', 'Empty sections']);
		expect(host.querySelector('.d1-view-rail')?.textContent).toContain('Saved for every sample page on this device.');
		expect(host.querySelector('.d1-view-rail')?.textContent).not.toContain('Activity range');
	});

	it('shows empty sections and lists them dimmed until told to hide them', async () => {
		await mount();
		expect(sections()).toEqual(['Operations', 'Tests', 'Files']);
		expect(host.querySelector('.hidden-note')).toBeNull();
	});

	it('hides empty sections, counts them under "On this page", and shows them again', async () => {
		await mount();
		await choose('Empty sections', 'Hide');
		expect(sections()).toEqual(['Operations']);
		expect([...host.querySelectorAll('.d1-page-contents .entry .title')].map((e) => e.textContent)).toEqual(['Operations']);
		expect(host.querySelector('.hidden-note')?.textContent).toBe('2 empty sections hidden');
		await choose('Empty sections', 'Show');
		expect(sections()).toEqual(['Operations', 'Tests', 'Files']);
		expect(host.querySelector('.hidden-note')).toBeNull();
	});

	it('sets the density of every table in the panels', async () => {
		await mount();
		expect(host.querySelector('table')?.className).not.toContain('compact');
		await choose('Table density', 'Compact');
		expect(host.querySelector('table')?.className).toContain('compact');
		await choose('Table density', 'Roomy');
		expect(host.querySelector('table')?.className).toContain('roomy');
	});

	it('puts the panels in two independent stacks, or one', async () => {
		await mount();
		expect(host.querySelector('.main')?.className).not.toContain('two-stacks');
		await choose('Panels', '2 columns');
		expect(host.querySelector('.main')?.className).toContain('two-stacks');
		await choose('Panels', '1 column');
		expect(host.querySelector('.main')?.className).not.toContain('two-stacks');
	});

	it('remembers the choices for the kind, and a dot on the collapsed tab says the view is not the default', async () => {
		await mount();
		await choose('Panels', '2 columns');
		await choose('Empty sections', 'Hide');
		await nextTick();
		expect(JSON.parse(localStorage.getItem('d1.view.sample')!)).toMatchObject({ panels: 2, empty: 'hide', density: 'normal' });
		app!.unmount();
		host.innerHTML = '';
		localStorage.setItem('d1.view.sample.open', '0');
		await mount();
		expect(host.querySelector('.main')?.className).toContain('two-stacks');
		expect(sections()).toEqual(['Operations']);
		expect(host.querySelector('.tab .dot')).toBeTruthy();
		expect(host.querySelector('.tab')?.textContent).toContain('View · 2 columns · Normal · Empty hidden');
	});
});
