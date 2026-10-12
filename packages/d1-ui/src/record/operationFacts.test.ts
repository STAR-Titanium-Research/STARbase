import { describe, expect, it } from 'vitest';
import {
	campaignFact, operationDetailBase, operationKind, operationRailFacts, operationSampleCount, personText, projectFact,
} from './operationFacts';

const sample = { sample_id: 's1', sample_code: '10-AA-1' };
const op = {
	operation_date: '2024-05-02',
	process_category: 'machining',
	operation_sequence: 3,
	method_id: { method_name: 'Turning' },
	equipment_id: { equipment_name: 'NLX 2500' },
	owner_person_id: { full_name: 'Ada Owner' },
	operator_person_id: { full_name: 'Bo Operator' },
	sample_id: sample,
	project_id: { project_id: 'p1', project_code: '10' },
	campaign_id: { campaign_id: 'c1', campaign_code: 'C-6' },
};
const byLabel = (facts: ReturnType<typeof operationRailFacts>, label: string) => facts.find((f) => f.label === label);

describe('operationKind', () => {
	it('names the process category, and is plain without one', () => {
		expect(operationKind(op)).toBe('Operation · Machining');
		expect(operationKind({ process_category: null })).toBe('Operation');
		expect(operationKind(null)).toBe('Operation');
	});
});

describe('operationRailFacts', () => {
	it('has the old header line, the method and the links up the tree, in order', () => {
		const facts = operationRailFacts(op, {});
		expect(facts.map((f) => f.label)).toEqual(['Date', 'Method', 'Machine', 'Owner', 'Operator', 'Sample', 'Project', 'Campaign']);
		expect(byLabel(facts, 'Date')?.value).toBe('2 May 2024');
		expect(byLabel(facts, 'Machine')?.value).toBe('NLX 2500');
		expect(byLabel(facts, 'Sample')).toMatchObject({ value: '10-AA-1', to: '/home/samples/s1' });
		expect(byLabel(facts, 'Project')).toMatchObject({ value: '10', to: '/home/projects/p1' });
		expect(byLabel(facts, 'Campaign')).toMatchObject({ value: 'C-6', to: '/home/campaigns/c1', mono: true });
	});

	it('says Undated when there is no date', () => {
		expect(byLabel(operationRailFacts({ ...op, operation_date: null }, {}), 'Date')?.value).toBe('Undated');
	});

	it('falls back to the free-text operator name', () => {
		const facts = operationRailFacts({ ...op, operator_person_id: null, operator_name: 'J. Smith' }, {});
		expect(byLabel(facts, 'Operator')?.value).toBe('J. Smith');
	});

	it('marks a hidden project and campaign instead of leaving them blank', () => {
		const facts = operationRailFacts({ ...op, project_id: null, campaign_id: null }, { project_id: true, campaign_id: true });
		expect(byLabel(facts, 'Project')).toMatchObject({ hidden: true, value: null });
		expect(byLabel(facts, 'Campaign')).toMatchObject({ hidden: true, value: null });
	});

	it('leaves the project out when there is none and nothing is hidden', () => {
		const project = byLabel(operationRailFacts({ ...op, project_id: null }, {}), 'Project');
		expect(project?.value).toBeNull();
		expect(project?.hidden).toBeUndefined();
	});

	it('names the output sample only when no input is linked at all', () => {
		const out = { sample_id: 's2', sample_code: '10-AA-2' };
		expect(byLabel(operationRailFacts({ ...op, sample_id: null, output_sample_id: out }, {}), 'Sample')?.value).toBe('10-AA-2');
		// A hidden input is not replaced by the output.
		const hidden = operationRailFacts({ ...op, sample_id: null, output_sample_id: out }, { sample_id: true });
		expect(byLabel(hidden, 'Sample')).toMatchObject({ hidden: true, value: null });
	});

	it('marks a sample whose link came back as a bare id (not readable) as hidden', () => {
		expect(byLabel(operationRailFacts({ ...op, sample_id: 's9' }, {}), 'Sample')?.hidden).toBe(true);
	});

	it('is empty without a record', () => {
		expect(operationRailFacts(null, {})).toEqual([]);
	});
});

describe('operationDetailBase', () => {
	it('has the Overview values the rail does not (no method)', () => {
		const facts = operationDetailBase({
			operation_sequence: 3, capture_software: 'DAQ', capture_frequency_khz: 100, force_file_id: 'F1', source_system: 'import',
		});
		expect(facts.map((f) => f.label)).toEqual(['Step', 'Capture software', 'Capture frequency', 'Force file ID', 'Imported from']);
		expect(facts[2]).toMatchObject({ value: '100', unit: 'kHz' });
		expect(facts[3].mono).toBe(true);
	});
});

describe('operationSampleCount', () => {
	it('counts the input and the output, a hidden one included', () => {
		expect(operationSampleCount(op, {})).toBe(1);
		expect(operationSampleCount({ ...op, output_sample_id: { sample_id: 's2' } }, {})).toBe(2);
		expect(operationSampleCount({ ...op, sample_id: null }, { sample_id: true })).toBe(1);
		expect(operationSampleCount({ ...op, sample_id: null }, {})).toBe(0);
		expect(operationSampleCount(null, {})).toBe(0);
	});
});

describe('link helpers', () => {
	it('names a campaign without a code by its name, not in monospace', () => {
		expect(campaignFact({ campaign_id: 'c2', name: 'Spring run' })).toMatchObject({ value: 'Spring run', mono: false });
	});
	it('projectFact links by id', () => {
		expect(projectFact({ project_id: 'p 1', project_code: '7' })).toMatchObject({ to: '/home/projects/p%201' });
	});
	it('personText prefers the linked person', () => {
		expect(personText({ full_name: 'A' }, 'B')).toBe('A');
		expect(personText(null, null)).toBe('');
	});
});
