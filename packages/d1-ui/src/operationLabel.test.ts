import { describe, expect, it } from 'vitest';
import { hasPassCode, operationLabel } from './operationLabel';

describe('operationLabel', () => {
	it('is the pass code when there is one', () => {
		expect(operationLabel({ pass_code: '10-AA-MF-2023-3-31-F27', operation_sequence: 27, sample_id: { sample_code: '10-AA-MF-2023-3-31' } })).toBe(
			'10-AA-MF-2023-3-31-F27',
		);
	});

	it('names the sample and step of an operation without a pass code', () => {
		expect(operationLabel({ pass_code: null, operation_sequence: 27, sample_id: { sample_code: '10-AA-MF-2023-3-31' } })).toBe(
			'10-AA-MF-2023-3-31 · step 27',
		);
	});

	it('treats an empty or blank pass code as missing', () => {
		expect(operationLabel({ pass_code: '', operation_sequence: 2, sample_id: { sample_code: 'S1' } })).toBe('S1 · step 2');
		expect(operationLabel({ pass_code: '  ', operation_sequence: 2, sample_id: { sample_code: 'S1' } })).toBe('S1 · step 2');
	});

	it('counts step 0 as a step', () => {
		expect(operationLabel({ operation_sequence: 0, sample_id: { sample_code: 'S1' } })).toBe('S1 · step 0');
	});

	it('degrades without the step', () => {
		expect(operationLabel({ sample_id: { sample_code: 'S1' } })).toBe('Operation on S1');
	});

	it('degrades without the sample', () => {
		expect(operationLabel({ operation_sequence: 4 })).toBe('Uncoded operation · step 4');
		expect(operationLabel({ operation_sequence: 4, sample_id: null })).toBe('Uncoded operation · step 4');
	});

	it('falls back to "Uncoded operation", never the bare word "Operation"', () => {
		expect(operationLabel({})).toBe('Uncoded operation');
		expect(operationLabel({ pass_code: null, operation_sequence: null, sample_id: null })).toBe('Uncoded operation');
	});

	it('ignores a sample that came back as a bare id or without a code', () => {
		expect(operationLabel({ operation_sequence: 4, sample_id: 'a1b2' })).toBe('Uncoded operation · step 4');
		expect(operationLabel({ operation_sequence: 4, sample_id: { sample_code: null } })).toBe('Uncoded operation · step 4');
	});

	it('takes the sample code from the second argument when the row has no sample', () => {
		expect(operationLabel({ operation_sequence: 4 }, 'S9')).toBe('S9 · step 4');
		expect(operationLabel({ operation_sequence: 4, sample_id: { sample_code: 'S1' } }, 'S9')).toBe('S1 · step 4');
	});
});

describe('hasPassCode', () => {
	it('is true only for a non-blank pass code', () => {
		expect(hasPassCode({ pass_code: 'X-F1' })).toBe(true);
		expect(hasPassCode({ pass_code: '' })).toBe(false);
		expect(hasPassCode({ pass_code: ' ' })).toBe(false);
		expect(hasPassCode({ pass_code: null })).toBe(false);
		expect(hasPassCode({})).toBe(false);
		expect(hasPassCode(null)).toBe(false);
	});
});
