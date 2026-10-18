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

	it('is disabled and says how many things are missing while blocking checks exist', async () => {
		const html = await render({ ...base, missing: 3 });
		expect(text(html)).toBe('3 things missing');
		expect(button(html)).toContain('disabled');
		expect(button(html)).toContain('Create 2 operations, 4 samples'); // the title still says what it would make
		expect((await render({ ...base, missing: 1 })).includes('1 thing missing')).toBe(true);
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
	});

	it('puts a failed Create\'s reason in an alert the button points at', async () => {
		const html = await render({ ...base, error: 'Could not reach the server; nothing was created' });
		expect(html).toContain('role="alert"');
		expect(text(html)).toContain('Could not reach the server; nothing was created');
		const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
		expect(id).toBeTruthy();
		expect(html).toContain(`id="${id}"`);
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
