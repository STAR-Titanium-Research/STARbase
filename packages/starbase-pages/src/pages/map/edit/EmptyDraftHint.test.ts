import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import EmptyDraftHint from './EmptyDraftHint.vue';

describe('EmptyDraftHint (fix 11)', () => {
	it('says what to do first, in words that are true without the palette', async () => {
		const html = await renderToString(createSSRApp({ render: () => h(EmptyDraftHint as never) }));
		expect(html).toContain('Nothing here yet');
		expect(html).toContain('Pick samples');
		expect(html).toContain('Shift+A');
		expect(html).toContain('operation or test');
		expect(html).toContain('role="status"');
		expect(html).not.toContain('palette');
	});
});
