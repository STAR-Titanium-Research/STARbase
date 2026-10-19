import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import WorkToggle from './WorkToggle.vue';

const render = (props: Record<string, unknown>) => renderToString(createSSRApp({ render: () => h(WorkToggle as never, props) }));

describe('WorkToggle', () => {
	it('is a Planned / Done radio group that marks the current state', async () => {
		const planned = await render({ state: 'planned', what: 'operation' });
		expect(planned).toContain('role="radiogroup"');
		expect(planned).toContain('aria-label="This operation is"');
		expect(planned).toMatch(/<button[^>]*data-state="planned"[^>]*aria-checked="true"|<button[^>]*aria-checked="true"[^>]*data-state="planned"/);
		expect(planned).toMatch(/<button[^>]*data-state="done"[^>]*aria-checked="false"|<button[^>]*aria-checked="false"[^>]*data-state="done"/);
		expect(planned).toContain('Laid out for later');
	});

	it('says what Done does at Create', async () => {
		const done = await render({ state: 'done', what: 'test' });
		expect(done).toContain('aria-label="This test is"');
		expect(done).toMatch(/<button[^>]*data-state="done"[^>]*aria-checked="true"|<button[^>]*aria-checked="true"[^>]*data-state="done"/);
		expect(done).toContain('Create writes it as done');
		expect(done).toContain('date it happened');
		expect(done).toContain('active');
	});
});
