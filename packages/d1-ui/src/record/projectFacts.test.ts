import { describe, expect, it } from 'vitest';
import { visibleFacts } from './facts';
import { dateRangeText, projectContents, projectRailFacts, type ProjectCounts } from './projectFacts';

const project = {
	project_id: 'p1',
	project_code: '10',
	start_date: '2024-01-05',
	end_date: '2025-03-09',
	document_number: 'DOC-7',
	export_controlled: false,
	principal_investigator_person: { full_name: 'Ada PI' },
};
const counts: ProjectCounts = { samples: 1234, operations: 40, tests: 0, campaigns: 3 };
const byLabel = (facts: ReturnType<typeof projectRailFacts>, label: string) => facts.find((f) => f.label === label);

describe('dateRangeText', () => {
	it('reads both, one or neither end', () => {
		expect(dateRangeText('2024-01-05', '2025-03-09')).toBe('5 Jan 2024 to 9 Mar 2025');
		expect(dateRangeText('2024-01-05', null)).toBe('From 5 Jan 2024');
		expect(dateRangeText(null, '2025-03-09')).toBe('Until 9 Mar 2025');
		expect(dateRangeText(null, undefined)).toBe('');
	});
});

describe('projectRailFacts', () => {
	it('has the old meta line, then the counts, in order', () => {
		const facts = projectRailFacts(project, ['Bo', 'Cy'], counts, false);
		expect(visibleFacts(facts).map((f) => f.label)).toEqual([
			'Dates', 'PI', 'Investigators', 'Document', 'Samples', 'Operations', 'Tests', 'Campaigns',
		]);
		expect(byLabel(facts, 'Dates')?.value).toBe('5 Jan 2024 to 9 Mar 2025');
		expect(byLabel(facts, 'PI')?.value).toBe('Ada PI');
		expect(byLabel(facts, 'Investigators')?.list).toEqual([{ label: 'Bo' }, { label: 'Cy' }]);
		expect(byLabel(facts, 'Document')?.value).toBe('DOC-7');
	});

	it('says the PI is not set, and leaves out what is empty (no investigators, no document)', () => {
		const facts = projectRailFacts({ project_id: 'p1' }, [], counts, false);
		expect(byLabel(facts, 'PI')?.value).toBe('not set');
		expect(visibleFacts(facts).map((f) => f.label)).toEqual(['PI', 'Samples', 'Operations', 'Tests', 'Campaigns']);
	});

	it('shows the samples, operations and tests counts as plain text: the project rule counts more than the index filter lists', () => {
		const facts = projectRailFacts(project, [], counts, false);
		for (const label of ['Samples', 'Operations', 'Tests']) {
			expect(byLabel(facts, label)?.to, label).toBeUndefined();
			expect(byLabel(facts, label)?.anchor, label).toBeUndefined();
		}
		expect(byLabel(facts, 'Samples')?.value).toBe('1,234');
		expect(byLabel(facts, 'Tests')?.value).toBe('0');
	});

	it('points the Campaigns count at the Campaigns panel', () => {
		expect(byLabel(projectRailFacts(project, [], counts, false), 'Campaigns')).toMatchObject({ value: '3', anchor: 'campaigns' });
	});

	it('leaves the counts out while they load, and shows a dash (no link) for one the role cannot read', () => {
		const loading = projectRailFacts(project, [], { samples: null, operations: null, tests: null, campaigns: null }, true);
		expect(visibleFacts(loading).map((f) => f.label)).toEqual(['Dates', 'PI', 'Document']);
		const partial = projectRailFacts(project, [], { samples: null, operations: 4, tests: 5, campaigns: null }, false);
		expect(byLabel(partial, 'Samples')?.value).toBe('–');
		expect(byLabel(partial, 'Campaigns')).toMatchObject({ value: '–', anchor: undefined });
	});

	it('is empty without a project', () => {
		expect(projectRailFacts(null, [], counts, false)).toEqual([]);
	});
});

describe('projectContents', () => {
	const rows = { campaigns: 3, samples: 0, operations: 2, tests: null, equipment: 5 };
	it('lists the panels in page order with the ids the sections carry', () => {
		const entries = projectContents({ hasDescription: true, ...rows });
		expect(entries.map((e) => e.id)).toEqual([
			'description', 'campaigns', 'unassigned-samples', 'unassigned-operations', 'unassigned-tests', 'activity', 'equipment',
		]);
		expect(entries.find((e) => e.id === 'campaigns')?.count).toBe(3);
		expect(entries.find((e) => e.id === 'unassigned-tests')?.count).toBeNull();
	});

	it('leaves out the Description panel when there is none', () => {
		expect(projectContents({ hasDescription: false, ...rows }).map((e) => e.id)).not.toContain('description');
	});
});
