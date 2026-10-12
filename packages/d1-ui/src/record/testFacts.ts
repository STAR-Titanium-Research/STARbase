// What the Test page shows beside and inside its panels: the rail's key facts, the Details panel's
// own facts and the counts of the contents list. Pure and tested here (the extension has no test
// runner); see operationFacts.ts for the Operation page's twin.

import { asRecord, formatDate, formatQuantity } from '../format';
import { humanise } from '../status';
import type { TestSubjects } from '../testSubjects';
import { campaignFact, personText, projectFact, sampleFact, type HiddenLinks } from './operationFacts';
import type { Fact } from './facts';

type Rec = Record<string, any>;

/** The test's heading: its type, "Test" when it has none. */
export const testTypeText = (t: Rec | null | undefined): string => (t?.test_type ? humanise(t.test_type) : 'Test');

/** The sample the test was run on: the single-sample column, else the first sample subject. */
export function testSample(t: Rec | null | undefined, subjects: TestSubjects): Rec | null {
	return asRecord(t?.sample_id) ?? subjects.samples[0] ?? null;
}

/** The rail's key facts: the old header's meta line (category, owner, operator, machine), the date
 *  (the old header's second line) and the links up the tree. */
export function testRailFacts(t: Rec | null | undefined, subjects: TestSubjects, hidden: HiddenLinks): Fact[] {
	if (!t) return [];
	const sample = testSample(t, subjects);
	return [
		{ label: 'Date', value: formatDate(t.session_date, 'Undated') },
		{ label: 'Category', value: t.test_category ? humanise(t.test_category) : '' },
		{ label: 'Machine', value: asRecord(t.equipment_id)?.equipment_name },
		{ label: 'Owner', value: asRecord(t.owner_person_id)?.full_name },
		{ label: 'Operator', value: personText(t.operator_person_id, t.operator_name) },
		sampleFact(sample, !sample && (!!hidden.sample_id || subjects.hidden > 0)),
		projectFact(asRecord(t.project_id), hidden.project_id),
		campaignFact(asRecord(t.campaign_id), hidden.campaign_id),
	];
}

/** The test's own values for the Details panel (the type is the rail's heading and the category and
 *  machine are rail facts, so none of them is repeated); parameters follow. */
export function testDetailBase(t: Rec | null | undefined): Fact[] {
	if (!t) return [];
	return [
		{ label: 'Capture software', value: t.capture_software },
		{ label: 'Capture frequency', value: formatQuantity(t.capture_frequency_khz), unit: 'kHz' },
		{ label: 'Raw file size', value: formatQuantity(t.file_size_gb), unit: 'GB' },
		{ label: 'Raw file', value: t.file_storage_pointer, mono: true },
	];
}

/** Rows of the Subject panel: the samples (the primary one listed once), other subjects and the
 *  ones the user may not see. */
export function testSubjectCount(sample: unknown, subjects: TestSubjects, sampleHidden: boolean): number {
	const direct = asRecord(sample);
	const samples = subjects.samples.length + (direct && !subjects.samples.some((s) => s.sample_id === direct.sample_id) ? 1 : 0);
	return samples + subjects.others.length + Math.max(subjects.hidden, sampleHidden ? 1 : 0);
}
