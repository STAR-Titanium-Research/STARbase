import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import DraftScope from './DraftScope.vue';

const projects = [{ value: 'pa', label: 'P-A · Alpha' }, { value: 'pb', label: 'P-B' }];
const campaigns = [
	{ value: 'ca', label: 'C-A', projectId: 'pa' },
	{ value: 'cb', label: 'C-B', projectId: 'pb' },
];
const render = (props: Record<string, unknown>) => renderToString(createSSRApp({ render: () => h(DraftScope as never, { projects, campaigns, projectId: null, campaignId: null, ...props }) }));
const select = (html: string, label: string): string => new RegExp(`<select[^>]*aria-label="${label}"[^>]*>.*?</select>`, 's').exec(html)?.[0] ?? '';
const options = (sel: string): string[] => [...sel.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);

describe('DraftScope (R12)', () => {
	it('has a project and a campaign select, with None first', async () => {
		const html = await render({});
		expect(html).toContain('role="group"');
		expect(options(select(html, 'Project'))).toEqual(['', 'pa', 'pb']);
		expect(options(select(html, 'Campaign'))).toEqual(['', 'ca', 'cb']);
	});

	it('offers only the campaigns of the chosen project, and shows the chosen ones', async () => {
		const html = await render({ projectId: 'pa', campaignId: 'ca' });
		expect(options(select(html, 'Campaign'))).toEqual(['', 'ca']);
		expect(select(html, 'Project')).toMatch(/<option[^>]*value="pa"[^>]*selected/);
		expect(select(html, 'Campaign')).toMatch(/<option[^>]*value="ca"[^>]*selected/);
	});

	it('still shows a project or campaign the lists do not hold (cut, or not readable)', async () => {
		const html = await render({ projectId: 'zz', campaignId: 'cz' });
		expect(options(select(html, 'Project'))).toContain('zz');
		expect(options(select(html, 'Campaign'))).toContain('cz');
	});

	it('says what is wrong with a list', async () => {
		const html = await render({ note: 'Could not load the campaigns: boom' });
		expect(html).toContain('Could not load the campaigns');
	});
});
