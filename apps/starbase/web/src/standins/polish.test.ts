import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileScript, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { createSSRApp, h, resolveComponent, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { registerStandins } from './register';

// Task 4 review follow-ups for the stand-ins. No DOM here, so: SSR renders for what shows, and the SFC's
// compiled bindings for "is this value reactive" (a `computed()` is a `setup-ref` binding; a value read
// once in setup is not).
const sfc = (name: string) => parse(readFileSync(fileURLToPath(new URL(`./${name}.vue`, import.meta.url)), 'utf8'));
const bindingOf = (name: string, binding: string) => {
	const d = sfc(name).descriptor;
	return compileScript(d, { id: name }).bindings?.[binding];
};
async function render(tag: string, props: Record<string, unknown> = {}) {
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
	const app = createSSRApp({ render: () => h(resolveComponent(tag) as Component, props, { default: () => 'x' }) });
	registerStandins(app);
	app.use(router);
	await router.push('/');
	await router.isReady();
	return renderToString(app);
}

describe('derived values follow their props', () => {
	it('v-progress-circular: dim is a computed', () => {
		expect(bindingOf('VProgressCircular', 'dim')).toBe('setup-ref');
	});
	it('v-notice: role is a computed', () => {
		expect(bindingOf('VNotice', 'role')).toBe('setup-ref');
	});
});

describe('v-icon title', () => {
	it('a plain icon with a title is an image named by it, not hidden', async () => {
		const html = await render('v-icon', { name: 'info', title: 'Estimated value' });
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-label="Estimated value"');
		expect(html).toContain('title="Estimated value"');
		expect(html).not.toContain('aria-hidden');
	});
	it('a plain icon with no title stays decorative', async () => {
		const html = await render('v-icon', { name: 'info' });
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain('role=');
	});
	it('a clickable icon keeps its button role, and its title names it', async () => {
		const html = await render('v-icon', { name: 'download', clickable: true, title: 'Download' });
		expect(html).toContain('role="button"');
		expect(html).toContain('aria-label="Download"');
		expect(html).not.toContain('aria-hidden');
	});
});

describe('v-button', () => {
	it('disabled with `to` is a disabled <button> with no href', async () => {
		const html = await render('v-button', { to: '/home/samples/1', disabled: true });
		expect(html).toMatch(/<button[^>]*disabled/);
		expect(html).not.toContain('href');
		expect(html).not.toContain('<a');
	});
	it('a left icon gets the button gap only: its own margin is switched off (no 8px double gap)', () => {
		const css = sfc('VButton').descriptor.styles.map((s) => s.content).join('\n');
		expect(css).toMatch(/gap:\s*4px/);
		expect(css).toMatch(/:deep\(\.v-icon\.left\)\s*\{[^}]*margin-right:\s*0/);
		expect(css).toMatch(/:deep\(\.v-icon\.right\)\s*\{[^}]*margin-left:\s*0/);
	});
});

describe('v-dialog', () => {
	it('keeps the card shadow: the scroll box has padding (and a matching negative margin) instead of clipping it', () => {
		const css = sfc('VDialog').descriptor.styles.map((s) => s.content).join('\n');
		const rule = /\.v-dialog\s*\{([^}]*)\}/.exec(css)![1];
		expect(rule).toMatch(/overflow:\s*auto/);
		expect(rule).toMatch(/padding:\s*24px/);
		expect(rule).toMatch(/margin:\s*-24px/);
	});
});
