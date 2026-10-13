import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileTemplate, parse } from '@vue/compiler-sfc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h, resolveComponent, resolveDirective, withDirectives, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, shouldOpenFinder, starbaseLinks } from '@d1/ui';
import { activateOnKey } from './clickableKey';
import { fromInputValue, toInputValue } from './inputModel';
import { registerStandins } from './register';
import { DESELECT, optionKey, valueFor } from './selectModel';
import { applyTooltip } from './tooltip';

// No DOM in this workspace: the stand-ins are rendered to HTML (vue/server-renderer), and what they do
// on input is tested through their pure helpers. Clicking through them is the e2e's job (Task 12).
const D1 = 'https://d1-server.tail54eeb6.ts.net';

async function render(node: () => ReturnType<typeof h>) {
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
	const app = createSSRApp({ render: node });
	registerStandins(app);
	app.use(router);
	await router.push('/');
	await router.isReady();
	const ctx: { teleports?: Record<string, string> } = {};
	const html = await renderToString(app, ctx);
	return { html, teleported: Object.values(ctx.teleports ?? {}).join('') };
}
const v = (tag: string, props: Record<string, unknown> = {}, slots: Record<string, () => unknown> = {}) => () =>
	h(resolveComponent(tag) as Component, props, slots as never);

afterEach(() => resetLinks());

describe('v-button', () => {
	it('a STARbase page link stays in the app', async () => {
		configureLinks(starbaseLinks(D1));
		const { html } = await render(v('v-button', { to: '/home/samples/1', secondary: true }, { default: () => 'Sample' }));
		expect(html).toContain('href="/samples/1"');
		expect(html).not.toContain('target="_blank"');
		expect(html).toContain('v-button');
		expect(html).toContain('secondary');
	});
	it('a Data Studio link opens d1-server in a new tab', async () => {
		configureLinks(starbaseLinks(D1));
		const { html } = await render(v('v-button', { to: '/content/projects/+' }, { default: () => 'New project' }));
		expect(html).toContain(`href="${D1}/admin/content/projects/+"`);
		expect(html).toContain('target="_blank"');
	});
	it('without `to` it is a button; loading disables it', async () => {
		const { html } = await render(v('v-button', { loading: true, kind: 'danger' }, { default: () => 'Delete' }));
		expect(html).toMatch(/<button[^>]*type="button"/);
		expect(html).toContain('disabled');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('danger');
	});
});

describe('v-dialog', () => {
	it('renders nothing while closed, so Ctrl+K still opens the finder', async () => {
		const { html, teleported } = await render(v('v-dialog', { modelValue: false }, { default: () => 'Body' }));
		expect(html + teleported).not.toContain('aria-modal');
		expect(html + teleported).not.toContain('Body');
	});
	it('open, it is a modal dialog: the finder stays shut over it', async () => {
		const { teleported } = await render(v('v-dialog', { modelValue: true }, { default: () => 'Body' }));
		expect(teleported).toContain('role="dialog"');
		expect(teleported).toContain('aria-modal="true"');
		expect(teleported).toContain('Body');
	});
	it('shouldOpenFinder refuses Ctrl+K over an open dialog, and allows it over a closed one', async () => {
		// No DOM: a document whose querySelector answers the finder's modal selector from the rendered HTML.
		// `[role="dialog"][aria-modal="true"]` is the part of the real selector the stand-in must satisfy.
		const docOver = (html: string) => ({
			querySelector: (sel: string) => (sel.includes('[role="dialog"][aria-modal="true"]') && /role="dialog"[^>]*aria-modal="true"/.test(html) ? {} : null),
		});
		const key = () => ({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault: () => undefined });
		const open = await render(v('v-dialog', { modelValue: true }, { default: () => 'Body' }));
		const closed = await render(v('v-dialog', { modelValue: false }, { default: () => 'Body' }));
		expect(shouldOpenFinder(key(), false, docOver(open.teleported))).toBe(false);
		expect(shouldOpenFinder(key(), false, docOver(closed.html + closed.teleported))).toBe(true);
	});
});

describe('the other stand-ins', () => {
	it('v-icon: the glyph, its size, and a clickable one is a button', async () => {
		expect((await render(v('v-icon', { name: 'edit', xSmall: true }))).html).toMatch(/font-size:\s*14px/);
		const clickable = (await render(v('v-icon', { name: 'download', clickable: true }))).html;
		expect(clickable).toContain('role="button"');
		expect(clickable).toContain('>download<');
	});
	it('a clickable v-icon has the key handler wired in its client render', () => {
		// vitest compiles .vue for SSR, which drops event handlers, so compile the template for the browser
		// and read the render code: onKeydown must be bound to activateOnKey, and only when `clickable`.
		const sfc = parse(readFileSync(fileURLToPath(new URL('./VIcon.vue', import.meta.url)), 'utf8'));
		const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: 'VIcon.vue', id: 'v-icon', ssr: false });
		expect(compiled.errors).toEqual([]);
		expect(compiled.code).toMatch(/onKeydown:[^\n]*clickable[^\n]*activateOnKey/);
		expect(sfc.descriptor.scriptSetup!.content).toContain("from './clickableKey'");
	});
	it('activateOnKey: Enter and Space click and prevent the default; other keys do nothing', () => {
		const press = (key: string) => {
			const click = vi.fn();
			const preventDefault = vi.fn();
			activateOnKey({ key, currentTarget: { click }, preventDefault });
			return [click.mock.calls.length, preventDefault.mock.calls.length];
		};
		expect(press('Enter')).toEqual([1, 1]);
		expect(press(' ')).toEqual([1, 1]);
		expect(press('a')).toEqual([0, 0]);
		expect(press('Tab')).toEqual([0, 0]);
	});
	it('v-notice: danger and warning are alerts, others a status', async () => {
		expect((await render(v('v-notice', { type: 'danger' }, { default: () => 'Bad' }))).html).toContain('role="alert"');
		expect((await render(v('v-notice', {}, { default: () => 'Note' }))).html).toContain('role="status"');
	});
	it('v-input: type, placeholder and the prepend slot', async () => {
		const { html } = await render(v('v-input', { type: 'number', placeholder: '0', modelValue: 2.5 }, { prepend: () => h('i', 'S') }));
		expect(html).toContain('type="number"');
		expect(html).toContain('placeholder="0"');
		expect(html).toContain('value="2.5"');
		expect(html).toContain('<i>S</i>');
	});
	it('v-select: the placeholder, the items, and "None" only when something is chosen', async () => {
		const items = [{ text: 'Ti-6Al-4V', value: 'm1' }];
		const empty = (await render(v('v-select', { items, placeholder: 'Choose material…', showDeselect: true, modelValue: null }))).html;
		expect(empty).toContain('Choose material…');
		expect(empty).toContain('Ti-6Al-4V');
		expect(empty).not.toContain('— None —');
		expect((await render(v('v-select', { items, showDeselect: true, modelValue: 'm1' }))).html).toContain('— None —');
	});
	it('v-checkbox, v-textarea, v-progress-*, v-card-*', async () => {
		expect((await render(v('v-checkbox', { modelValue: true }))).html).toMatch(/type="checkbox"[^>]*checked/);
		expect((await render(v('v-textarea', { modelValue: 'n', placeholder: 'Optional' }))).html).toContain('placeholder="Optional"');
		expect((await render(v('v-progress-linear', { indeterminate: true }))).html).toContain('role="progressbar"');
		expect((await render(v('v-progress-circular', { indeterminate: true, small: true }))).html).toContain('role="progressbar"');
		expect((await render(v('v-card-title', {}, { default: () => 'Discard?' }))).html).toMatch(/<h2 class="v-card-title"[^>]*>(<!--\[-->)?Discard\?(<!--\]-->)?<\/h2>/);
	});
	it('v-tooltip renders a title', async () => {
		const { html } = await render(() => withDirectives(h('button', 'x'), [[resolveDirective('tooltip')!, 'Save']]));
		expect(html).toContain('title="Save"');
	});
});

describe('pure helpers', () => {
	it('v-input gives a number for type="number" (null when emptied), text otherwise', () => {
		expect(fromInputValue('2.5', 'number')).toBe(2.5);
		expect(fromInputValue('', 'number')).toBeNull();
		expect(fromInputValue('abc', 'number')).toBeNull();
		expect(fromInputValue(' x ', undefined)).toBe(' x ');
		expect(toInputValue(null)).toBe('');
		expect(toInputValue(0)).toBe('0');
	});
	it('v-select keys options by index, so any value type survives the native <select>', () => {
		const items = [{ text: 'A', value: 7 }, { text: 'B', value: 'u-1' }];
		expect(optionKey(items, 'u-1')).toBe('1');
		expect(optionKey(items, 'missing')).toBe('');
		expect(valueFor(items, '0')).toBe(7);
		expect(valueFor(items, DESELECT)).toBeNull();
		expect(valueFor(items, '9')).toBeNull();
	});
	it('the tooltip is the title, and the accessible name unless the element has its own', () => {
		const attrs = new Map<string, string>();
		const el = { dataset: {} as Record<string, string>, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k), hasAttribute: (k: string) => attrs.has(k) };
		applyTooltip(el, 'Copy file path');
		expect([attrs.get('title'), attrs.get('aria-label')]).toEqual(['Copy file path', 'Copy file path']);
		applyTooltip(el, 'Copied!');
		expect([attrs.get('title'), attrs.get('aria-label')]).toEqual(['Copied!', 'Copied!']);
		applyTooltip(el, '');
		expect(attrs.has('title') || attrs.has('aria-label')).toBe(false);
		const own = new Map([['aria-label', 'Download']]);
		const el2 = { dataset: {} as Record<string, string>, setAttribute: (k: string, v: string) => void own.set(k, v), removeAttribute: (k: string) => void own.delete(k), hasAttribute: (k: string) => own.has(k) };
		applyTooltip(el2, 'Download the file');
		expect(own.get('aria-label')).toBe('Download');
		expect(own.get('title')).toBe('Download the file');
	});
});
