import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { providePagePin, setExplorerHostFactory, usePins } from '@d1/ui';
import type { ExplorerHost, PinRef } from '@d1/ui';
import PlainFrame from './PlainFrame.vue';

// The page title's pin button: drawn only when the page provided a target, and it says whether that target is pinned.
const SAMPLE_PIN: PinRef = { kind: 'record', target: 'physical_samples:00000000-0000-4000-8000-000000000001' };

function host(pinned: PinRef[]): ExplorerHost {
	const get = vi.fn(async (path: string) => (path === '/d1-usage/nav' ? { data: { pins: pinned, prefs: {} } } : { data: { data: [] } }));
	return { api: { get, post: vi.fn() }, navigate: vi.fn(), openDataStudio: vi.fn(), user: ref(null) } as unknown as ExplorerHost;
}

async function render(target: PinRef | null | 'none', pinned: PinRef[] = []): Promise<string> {
	const h0 = host(pinned);
	setExplorerHostFactory(() => h0);
	await usePins().refresh();
	// The page sits above the frame, as ExplorerView puts it.
	const Page = defineComponent({
		setup() {
			if (target !== 'none') providePagePin(ref(target));
			return () => h(PlainFrame, { title: 'Sample 12' });
		},
	});
	return renderToString(createSSRApp(Page));
}

describe('PlainFrame title pin', () => {
	it('draws a pin button after the title when the page can be pinned', async () => {
		const html = await render(SAMPLE_PIN);
		expect(html).toMatch(/<h1[^>]*>Sample 12<\/h1><button[^>]*class="sb-pin"/);
		expect(html).toContain('title="Pin to the sidebar"');
		expect(html).toContain('aria-pressed="false"');
	});

	it('shows the pinned state and offers to unpin', async () => {
		const html = await render(SAMPLE_PIN, [SAMPLE_PIN]);
		expect(html).toContain('class="sb-pin on"');
		expect(html).toContain('title="Unpin from the sidebar"');
		expect(html).toContain('aria-pressed="true"');
	});

	it('draws no button when the page has nothing to pin', async () => {
		expect(await render(null)).not.toContain('sb-pin');
		expect(await render('none')).not.toContain('sb-pin');
	});
});
