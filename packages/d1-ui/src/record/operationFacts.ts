// What the Operation page shows beside and inside its panels, built from the records the page
// already loads: the rail's key facts, the Details panel's own facts, the rail's kind line and the
// counts of the contents list. Pure, so it is tested here (the extension has no test runner).

import { asRecord, formatDate, formatQuantity } from '../format';
import { processLabel } from '../process';
import { recordRoute } from '../recordRoute';
import type { Fact } from './facts';

type Rec = Record<string, any>;

/** Which linked records the user cannot see (`readHiddenLinks`), by column name. */
export type HiddenLinks = Record<string, boolean | undefined>;

/**
 * A link up the tree as a fact: the record's code linking to its page, "not visible to you" when row
 * level visibility hides it (never blank), and no value at all (so the fact is left out) when there
 * is none.
 */
export function linkFact(label: string, collection: string, idKey: string, target: Rec | null, shown: string, hidden?: boolean, mono = true): Fact {
	if (target) return { label, value: shown, to: recordRoute(collection, target[idKey]), mono };
	if (hidden) return { label, value: null, hidden: true };
	return { label, value: null };
}

export const projectFact = (project: Rec | null, hidden?: boolean) =>
	linkFact('Project', 'projects', 'project_id', project, project?.project_code ?? 'Project', hidden);

// A campaign without a code is named by its free-text name, which is not set as a code.
export const campaignFact = (campaign: Rec | null, hidden?: boolean) =>
	linkFact('Campaign', 'campaigns', 'campaign_id', campaign, campaign?.campaign_code || campaign?.name || 'Campaign', hidden, !!campaign?.campaign_code);

export const sampleFact = (sample: Rec | null, hidden?: boolean, label = 'Sample') =>
	linkFact(label, 'physical_samples', 'sample_id', sample, sample?.sample_code || 'Sample', hidden);

/** The person's name, else the free-text name an import wrote. */
export function personText(person: unknown, fallback?: string | null): string {
	return asRecord(person)?.full_name || fallback || '';
}

/** "Operation · Machining"; a plain "Operation" when it has no process category. */
export function operationKind(op: Rec | null | undefined): string {
	return op?.process_category ? `Operation · ${processLabel(op.process_category)}` : 'Operation';
}

/**
 * The sample the operation is about: the input, else (when no input is linked at all) the output.
 * A hidden input is reported as hidden, not replaced by the output: the output belongs to a
 * different step of the sample's life, and the heading makes the same choice.
 */
function aboutSample(op: Rec, hidden: HiddenLinks): { sample: Rec | null; hidden: boolean } {
	const input = asRecord(op.sample_id);
	if (input) return { sample: input, hidden: false };
	if (hidden.sample_id || (op.sample_id && !input)) return { sample: null, hidden: true };
	const output = asRecord(op.output_sample_id);
	if (output) return { sample: output, hidden: false };
	return { sample: null, hidden: !!hidden.output_sample_id || !!(op.output_sample_id && !output) };
}

/** The rail's key facts: the old header's meta line (date, owner, operator, machine) and the links
 *  up the tree, with the method that used to head the Overview. */
export function operationRailFacts(op: Rec | null | undefined, hidden: HiddenLinks): Fact[] {
	if (!op) return [];
	const about = aboutSample(op, hidden);
	return [
		{ label: 'Date', value: formatDate(op.operation_date, 'Undated') },
		{ label: 'Method', value: asRecord(op.method_id)?.method_name },
		{ label: 'Machine', value: asRecord(op.equipment_id)?.equipment_name },
		{ label: 'Owner', value: asRecord(op.owner_person_id)?.full_name },
		{ label: 'Operator', value: personText(op.operator_person_id, op.operator_name) },
		sampleFact(about.sample, about.hidden),
		projectFact(asRecord(op.project_id), hidden.project_id),
		campaignFact(asRecord(op.campaign_id), hidden.campaign_id),
	];
}

/** The operation's own values for the Details panel (the rail's facts left out); parameters follow. */
export function operationDetailBase(op: Rec | null | undefined): Fact[] {
	if (!op) return [];
	return [
		{ label: 'Step', value: op.operation_sequence },
		{ label: 'Capture software', value: op.capture_software },
		{ label: 'Capture frequency', value: formatQuantity(op.capture_frequency_khz), unit: 'kHz' },
		{ label: 'Force file ID', value: op.force_file_id, mono: true },
		{ label: 'Imported from', value: op.source_system },
	];
}

/** Rows of the "Samples in and out" panel: the input and the output, counting a hidden one. */
export function operationSampleCount(op: Rec | null | undefined, hidden: HiddenLinks): number {
	if (!op) return 0;
	const has = (key: 'sample_id' | 'output_sample_id') => !!(asRecord(op[key]) || hidden[key] || op[key]);
	return Number(has('sample_id')) + Number(has('output_sample_id'));
}
