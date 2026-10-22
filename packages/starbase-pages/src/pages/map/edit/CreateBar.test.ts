import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CreateBar from './CreateBar.vue';

const render = (props: Record<string, unknown>) => renderToString(createSSRApp(CreateBar, props));
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const button = (html: string) => html.match(/<button[^>]*>/)?.[0] ?? '';
const base = { summary: 'Create 2 operations, 4 samples', missing: 0, creating: false };

describe('CreateBar', () => {
	it('is a primary button saying what it will make', async () => {
		const html = await render(base);
		expect(text(html)).toBe('Create 2 operations, 4 samples');
		expect(button(html)).not.toContain('disabled');
		expect(button(html)).toContain('type="button"');
	});

	it('is a disabled Create with "N to fill in" beside it while blocking checks exist', async () => {
		const html = await render({ ...base, missing: 3 });
		expect(text(html)).toBe('3 to fill in Create');
		expect(html).toMatch(/<span class="fill"[^>]*>3 to fill in<\/span>/);
		expect(html.match(/<button[^>]*>[\s\S]*?<\/button>/)?.[0].replace(/<[^>]+>/g, '')).toBe('Create');
		expect(button(html)).toContain('disabled');
		expect(button(html)).toContain('Create 2 operations, 4 samples'); // the title still says what it would make
		expect(text(await render({ ...base, missing: 1 }))).toContain('1 to fill in');
	});

	it('says what it will make, with nothing beside it, once nothing is missing', async () => {
		expect(await render(base)).not.toContain('class="fill"');
	});

	it('shows a spinner and cannot be pressed while creating', async () => {
		const html = await render({ ...base, creating: true });
		expect(html).toContain('class="spin"');
		expect(text(html)).toBe('Creating…');
		expect(button(html)).toContain('disabled');
		expect(button(html)).toContain('aria-busy="true"');
		expect(await render(base)).not.toContain('class="spin"');
	});

	it('creating wins over missing: the spinner is the state', async () => {
		const html = await render({ ...base, creating: true, missing: 2 });
		expect(text(html)).toBe('Creating…');
		expect(html).not.toContain('class="fill"');
	});

	it('puts a failed Create\'s reason in an alert the button points at', async () => {
		const html = await render({ ...base, error: 'Could not reach the server; nothing was created' });
		expect(html).toContain('role="alert"');
		expect(text(html)).toContain('Could not reach the server; nothing was created');
		const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
		expect(id).toBeTruthy();
		expect(html).toContain(`id="${id}"`);
	});

	it('shows the server words when Create is refused for a missing researcher record, and the button can be pressed again', async () => {
		const html = await render({ ...base, error: "Your account isn't linked to a researcher record. Ask an admin." });
		expect(text(html)).toContain('Ask an admin.');
		expect(html).toContain('role="alert"');
		expect(button(html)).not.toContain('disabled');
	});

	it('has no error line without an error', async () => {
		expect(await render({ ...base, error: null })).not.toContain('role="alert"');
		expect(await render(base)).not.toContain('role="alert"');
	});

	it('a draft that makes nothing is disabled and says what to do', async () => {
		const html = await render({ summary: 'Add an operation, test or new sample to create', missing: 0, creating: false, empty: true });
		expect(button(html)).toContain('disabled');
		expect(text(html)).toBe('Add an operation, test or new sample to create');
	});
});
