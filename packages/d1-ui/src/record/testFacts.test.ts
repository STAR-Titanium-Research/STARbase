import { describe, expect, it } from 'vitest';
import { testDetailBase, testRailFacts, testSample, testSubjectCount, testTypeText } from './testFacts';
import type { TestSubjects } from '../testSubjects';

const none: TestSubjects = { samples: [], others: [], hidden: 0 };
const sample = { sample_id: 's1', sample_code: '10-AA-1' };
const test = {
	session_date: '2024-05-02',
	test_type: 'tensile',
	test_category: 'mechanical',
	equipment_id: { equipment_name: 'Instron' },
	owner_person_id: { full_name: 'Ada Owner' },
	operator_name: 'J. Smith',
	sample_id: sample,
	project_id: { project_id: 'p1', project_code: '10' },
};
const get = (facts: ReturnType<typeof testRailFacts>, label: string) => facts.find((f) => f.label === label);

describe('testTypeText', () => {
	it('humanises the type and falls back to Test', () => {
		expect(testTypeText(test)).toBe('Tensile');
		expect(testTypeText({ test_type: 'fatigue_hcf' })).toBe('Fatigue hcf');
		expect(testTypeText({})).toBe('Test');
	});
});

describe('testRailFacts', () => {
	it('has the date, category, machine, people and the links up the tree', () => {
		const facts = testRailFacts(test, none, {});
		expect(facts.map((f) => f.label)).toEqual(['Date', 'Category', 'Machine', 'Owner', 'Operator', 'Sample', 'Project', 'Campaign']);
		expect(get(facts, 'Category')?.value).toBe('Mechanical');
		expect(get(facts, 'Operator')?.value).toBe('J. Smith');
		expect(get(facts, 'Sample')).toMatchObject({ value: '10-AA-1', to: '/home/samples/s1' });
	});

	it('takes the first subject sample when the test has no single-sample column', () => {
		expect(testSample({ ...test, sample_id: null }, { ...none, samples: [sample] })).toBe(sample);
		expect(get(testRailFacts({ ...test, sample_id: null }, { ...none, samples: [sample] }, {}), 'Sample')?.value).toBe('10-AA-1');
	});

	it('marks the sample hidden when the column or the junction hides it, and only then', () => {
		const t = { ...test, sample_id: null };
		expect(get(testRailFacts(t, none, { sample_id: true }), 'Sample')).toMatchObject({ hidden: true });
		expect(get(testRailFacts(t, { ...none, hidden: 2 }, {}), 'Sample')).toMatchObject({ hidden: true });
		expect(get(testRailFacts(t, none, {}), 'Sample')?.hidden).toBeUndefined();
	});

	it('marks a hidden project', () => {
		expect(get(testRailFacts({ ...test, project_id: null }, none, { project_id: true }), 'Project')).toMatchObject({ hidden: true });
	});
});

describe('testDetailBase', () => {
	it('has the Overview values the rail and heading do not', () => {
		const facts = testDetailBase({ capture_software: 'X', capture_frequency_khz: 50, file_size_gb: 1.5, file_storage_pointer: 'share/a' });
		expect(facts.map((f) => f.label)).toEqual(['Capture software', 'Capture frequency', 'Raw file size', 'Raw file']);
		expect(facts[1]).toMatchObject({ value: '50', unit: 'kHz' });
		expect(facts[2]).toMatchObject({ value: '1.5', unit: 'GB' });
	});
});

describe('testSubjectCount', () => {
	it('lists the primary sample once even when the junction repeats it', () => {
		expect(testSubjectCount(sample, { ...none, samples: [sample] }, false)).toBe(1);
	});
	it('adds the primary sample when the junction has none, plus others and hidden ones', () => {
		expect(testSubjectCount(sample, none, false)).toBe(1);
		expect(testSubjectCount(null, { samples: [sample], others: [{ collection: 'insert_edges', item: 'e1' }], hidden: 2 }, false)).toBe(4);
	});
	it('counts a hidden primary sample as one unless the junction already counts more', () => {
		expect(testSubjectCount(null, none, true)).toBe(1);
		expect(testSubjectCount(null, { ...none, hidden: 3 }, true)).toBe(3);
	});
});
