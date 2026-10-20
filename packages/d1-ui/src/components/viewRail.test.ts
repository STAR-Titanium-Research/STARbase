import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ViewRail from './ViewRail.vue';
import ViewRailSection from './ViewRailSection.vue';
import { isRailToggleKey, readRailOpen, writeRailOpen } from './viewRail';

function fakeStorage(initial: Record<string, string> = {}, broken = false): Storage {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (k: string) => {
			if (broken) throw new Error('blocked');
			return data.get(k) ?? null;
		},
		setItem: (k: string, v: string) => {
			if (broken) throw new Error('blocked');
			data.set(k, v);
		},
	} as unknown as Storage;
}

describe('readRailOpen / writeRailOpen', () => {
	it('gives the default when nothing is stored', () => {
		expect(readRailOpen('k', false, fakeStorage())).toBe(false);
		expect(readRailOpen('k', true, fakeStorage())).toBe(true);
	});

	it('remembers what was left, over the default', () => {
		const s = fakeStorage();
		writeRailOpen('k', true, s);
		expect(readRailOpen('k', false, s)).toBe(true);
		writeRailOpen('k', false, s);
		expect(readRailOpen('k', true, s)).toBe(false);
	});

	it('ignores a value it did not write', () => {
		expect(readRailOpen('k', true, fakeStorage({ k: 'yes' }))).toBe(true);
	});

	it('survives blocked storage, and no storage at all', () => {
		const blocked = fakeStorage({}, true);
		expect(() => writeRailOpen('k', true, blocked)).not.toThrow();
		expect(readRailOpen('k', true, blocked)).toBe(true);
		expect(readRailOpen('k', false, null)).toBe(false);
		expect(() => writeRailOpen('k', true, null)).not.toThrow();
	});
});

describe('isRailToggleKey', () => {
	it('toggles on a backslash', () => {
		expect(isRailToggleKey({ key: '\\', target: { tagName: 'BODY' } })).toBe(true);
		expect(isRailToggleKey({ key: '\\' })).toBe(true);
	});

	it('ignores other keys', () => {
		expect(isRailToggleKey({ key: '/' })).toBe(false);
		expect(isRailToggleKey({ key: 'v' })).toBe(false);
	});

	it('is a character, not a shortcut, while typing in a field', () => {
		for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) expect(isRailToggleKey({ key: '\\', target: { tagName } })).toBe(false);
		expect(isRailToggleKey({ key: '\\', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
	});

	it('leaves modified keys and handled events to others', () => {
		expect(isRailToggleKey({ key: '\\', ctrlKey: true })).toBe(false);
		expect(isRailToggleKey({ key: '\\', metaKey: true })).toBe(false);
		expect(isRailToggleKey({ key: '\\', altKey: true })).toBe(false);
		expect(isRailToggleKey({ key: '\\', defaultPrevented: true })).toBe(false);
	});
});

// No window here, so the rail starts from its default: open shows the card and its sections, closed the tab.
async function render(props: Record<string, unknown>): Promise<string> {
	const Page = defineComponent({
		setup: () => () =>
			h(ViewRail, { storageKey: 'd1.view.test.open', ...props }, () => [
				h(ViewRailSection, { label: 'Panels' }, () => 'panel choices'),
				h(ViewRailSection, {}, () => 'Saved for every test page.'),
			]),
	});
	const app = createSSRApp(Page);
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) }));
	return renderToString(app);
}

describe('ViewRail', () => {
	it('draws the lid and the sections when open', async () => {
		const html = await render({ defaultOpen: true });
		expect(html).toContain('>View</span>');
		expect(html).toContain('aria-label="Collapse the View rail"');
		expect(html).toContain('Panels');
		expect(html).toContain('panel choices');
		expect(html).toContain('Saved for every test page.');
		expect(html).not.toContain('class="tab"');
	});

	it('draws the vertical tab with the summary when collapsed, without the sections', async () => {
		const html = await render({ summary: 'Normal · Created ↓' });
		expect(html).toContain('class="tab"');
		expect(html).toContain('View · Normal · Created ↓');
		expect(html).not.toContain('panel choices');
	});

	it('marks a changed view with a dot on the tab, named in the button\'s label, and an unchanged one without', async () => {
		const changed = await render({ modified: true });
		expect(changed).toContain('class="dot"');
		expect(changed).toContain('(changed)"');
		const same = await render({ modified: false });
		expect(same).not.toContain('class="dot"');
		expect(same).not.toContain('(changed)');
	});
});
