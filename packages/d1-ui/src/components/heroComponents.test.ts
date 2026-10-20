import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { AccessList } from '../access/accessModel';
import PeopleStack from './PeopleStack.vue';
import ProjectTimeline from './ProjectTimeline.vue';

// No DOM here, so the two hero components are rendered on the server (the width is unmeasured, so the SVG is drawn at its 640px default).
// Their numbers are tested in record/projectTimeline.test.ts and access/peopleStack.test.ts; this pins what they draw from them.
const render = async (component: object, props: Record<string, unknown>) =>
	(await renderToString(createSSRApp(component, props).component('v-icon', { render: () => null }))).replace(/ data-v-[a-z0-9]+/g, '');

const timeline = (over: Record<string, unknown> = {}) => ({
	project: { code: '10', start: '2026-01-05', end: '2026-12-31' },
	campaigns: [{ id: 'c1', code: '6', name: 'Undated', status: 'active', start: null, end: null }],
	ops: ['2026-10-12', '2026-10-13'],
	tests: ['2026-10-14'],
	plannedOps: [{ date: '2026-10-22', n: 2 }],
	plannedTests: [],
	today: new Date(2026, 9, 16),
	range: 'all',
	...over,
});

describe('ProjectTimeline', () => {
	it('draws the chart, the planned keys, the last-record line, the undated codes and the week table', async () => {
		const html = await render(ProjectTimeline, timeline());
		expect(html).toContain('Per week (operations and tests)');
		expect(html).toContain('Planned operation');
		expect(html).toContain('Planned test');
		expect(html).toContain('Last operation <b>13 Oct 2026</b>');
		expect(html).toContain('Undated: <b>6</b>');
		expect(html).toContain('2026-W42');
		expect(html).toContain('Timeline range');
	});
	it('has no planned keys when nothing is planned', async () => {
		expect(await render(ProjectTimeline, timeline({ plannedOps: [] }))).not.toContain('Planned operation');
	});
	it('says so in one line when the range holds nothing, with no svg', async () => {
		const html = await render(ProjectTimeline, timeline({ range: '30d', ops: ['2020-01-01'], tests: [], plannedOps: [], campaigns: [] }));
		expect(html).toContain('No operations or tests in the last 30 days.');
		expect(html).not.toContain('<svg');
	});
	it('notes a truncated read', async () => {
		expect(await render(ProjectTimeline, timeline({ truncated: true }))).toContain('Based on the newest records');
		expect(await render(ProjectTimeline, timeline())).not.toContain('Based on the newest records');
	});
});

const list = (n: number): AccessList => ({
	restricted: false,
	owner: { person_id: 'pi', name: 'Dennis Premoli', can_sign_in: true },
	project_pi: null,
	can_manage: false,
	entries: Array.from({ length: n }, (_, i) => ({
		person_id: `p${i}`, name: `Person ${String.fromCharCode(65 + i)}`, role: i < 2 ? 'investigator' : 'view', source: 'access' as const,
		can_sign_in: true, added_by: null, added_at: null, blocked_by: null,
	})),
	teams: [],
});

describe('PeopleStack', () => {
	it('words the line and hides the fading faces from screen readers', async () => {
		const html = await render(PeopleStack, { list: list(10), piName: 'Dennis Premoli' });
		expect(html).toContain('<b>Dennis Premoli</b> PI');
		expect(html).toContain('<b>2</b> investigators');
		expect(html).toContain('<b>8</b> more have access');
		expect(html).toContain('Who has access');
		expect(html.match(/role="listitem"/g)).toHaveLength(9);
		expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
	});
	it('is the PI alone, with no count, when the list could not be read', async () => {
		const html = await render(PeopleStack, { list: null, piName: 'Dennis Premoli' });
		expect(html).toContain('<b>Dennis Premoli</b> PI');
		expect(html).not.toContain('more have access');
		expect(html).not.toContain('</b> investigator');
		expect(html.match(/role="listitem"/g)).toHaveLength(1);
	});
	it('says "has" for one more person', async () => {
		expect(await render(PeopleStack, { list: list(3), piName: '' })).toContain('<b>1</b> more has access');
	});
});
