// What to call a manufacturing operation in a list or a heading. manufacturing_operations.pass_code
// is neither unique nor required, so some operations have none; printing a fixed word for those
// ("Operation") reads as a code and makes every such row look the same. The fallback is built from
// what does identify the operation: its sample and its step (`operation_sequence`).

export interface OperationLabelInput {
	pass_code?: string | null;
	operation_sequence?: number | null;
	/** The expanded relation (`sample_id.sample_code`); a bare id or null gives no code. */
	sample_id?: unknown;
}

const passCode = (op: OperationLabelInput | null | undefined): string => (typeof op?.pass_code === 'string' ? op.pass_code.trim() : '');

/** True when the operation has a real pass code, i.e. its label is a code and not a description. */
export function hasPassCode(op: OperationLabelInput | null | undefined): boolean {
	return passCode(op) !== '';
}

function sampleCodeOf(sample: unknown): string {
	if (typeof sample !== 'object' || sample === null) return '';
	const code = (sample as { sample_code?: unknown }).sample_code;
	return typeof code === 'string' ? code.trim() : '';
}

/**
 * The pass code, else `<sample code> · step <n>`. With only one of the two it is
 * `Operation on <sample code>` or `Uncoded operation · step <n>`; with neither, `Uncoded operation`.
 * `sampleCode` fills in when the row's own sample is missing (the Operation page falls back to the
 * output sample).
 */
export function operationLabel(op: OperationLabelInput | null | undefined, sampleCode?: string | null): string {
	const code = passCode(op);
	if (code) return code;
	const sample = sampleCodeOf(op?.sample_id) || (sampleCode ?? '').trim();
	const seq = op?.operation_sequence;
	const step = typeof seq === 'number' && Number.isFinite(seq) ? `step ${seq}` : '';
	if (sample && step) return `${sample} · ${step}`;
	if (sample) return `Operation on ${sample}`;
	if (step) return `Uncoded operation · ${step}`;
	return 'Uncoded operation';
}

/**
 * The Operation page's heading. `operation_sequence` numbers the steps of the INPUT sample, so a
 * step is never printed next to the output sample's code. The pass code, else the list label
 * (`operationLabel`) whenever the operation has an input-sample link, hidden or not; only when it
 * has none at all does the output sample name it, as `Operation on <code>` (no step).
 * `inputHidden` is also true while the page does not yet know whether a null input is hidden.
 */
export function operationHeading(op: OperationLabelInput | null | undefined, outputSampleCode: string | null | undefined, inputHidden: boolean): string {
	if (hasPassCode(op) || inputHidden || (op?.sample_id !== null && op?.sample_id !== undefined)) return operationLabel(op);
	return operationLabel({ sample_id: null }, outputSampleCode);
}
