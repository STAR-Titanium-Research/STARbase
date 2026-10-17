import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import FinderPreview from './FinderPreview.vue';
import type { PreviewCard } from './previewCard';
import type { PreviewState } from './usePreview';

// There is no DOM in this package's vitest, so the pane (a props-only component) is rendered on the server. Whether Finder.vue shows it is a pure
// decision (paneAllowed, widenLatch in finderNav.test.ts) and what it fetches is usePreview's (usePreview.test.ts).
const render = (props: { state: PreviewState; card: PreviewCard | null; labelledby?: string }) => renderToString(createSSRApp(FinderPreview, props));

const card: PreviewCard = {
	icon: 'test-tube', title: '12-ABC', kind: 'Sample · Disc', detail: 'a disc',
	facts: [{ label: 'Location', value: 'Shelf 2' }, { label: 'Archive path', value: 'sem/a.tif', mono: true }],
	matched: { field: 'notes', snippet: '…a crack…' },
};

describe('FinderPreview', () => {
	it('draws nothing but the (empty) live region when there is no card', async () => {
		const html = await render({ state: 'idle', card: null });
		expect(html).toContain('aria-live="polite"');
		expect(html).not.toContain('aria-atomic');
		expect(html).not.toContain('Open');
		expect(html).not.toContain('Preview unavailable');
	});

	it('is named by the active option, and only the facts are live (not the loading and unavailable notes)', async () => {
		const html = await render({ state: 'ready', card, labelledby: 'f-opt-3' });
		expect(html).toContain('aria-labelledby="f-opt-3"');
		expect(html).toMatch(/aria-live="polite"[^>]*><dl.*<\/dl><\/div>/s);
		const unavailable = await render({ state: 'unavailable', card: { ...card, facts: [] } });
		expect(unavailable.indexOf('Preview unavailable')).toBeGreaterThan(unavailable.indexOf('</div>', unavailable.indexOf('aria-live')));
	});

	it('shows the instant part with "Loading…" while the record is read', async () => {
		const html = await render({ state: 'loading', card: { ...card, facts: [] } });
		expect(html).toContain('12-ABC');
		expect(html).toContain('Sample · Disc');
		expect(html).toContain('Matched in notes');
		expect(html).toContain('…a crack…');
		expect(html).toContain('Loading…');
	});

	it('shows the facts and the Open hint when ready, with no button or link', async () => {
		const html = await render({ state: 'ready', card });
		expect(html).toContain('Location');
		expect(html).toContain('Shelf 2');
		expect(html).toContain('Open ↵');
		expect(html).not.toContain('Loading…');
		expect(html).not.toMatch(/<(button|a)[ >]/);
	});

	it('says "Preview unavailable" on a failed read, and the row still has its label', async () => {
		const html = await render({ state: 'unavailable', card: { ...card, facts: [] } });
		expect(html).toContain('Preview unavailable');
		expect(html).toContain('12-ABC');
	});

	it('names a relation match without a value', async () => {
		const html = await render({ state: 'ready', card: { ...card, matched: { field: 'owner' } } });
		expect(html).toContain('Matched in owner');
		expect(html).not.toContain('Matched in owner:');
	});
});
