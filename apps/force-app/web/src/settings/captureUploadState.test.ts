import { describe, expect, it } from 'vitest';
import { matchUploaded, uploadedRowsSince } from './captureUploadState';

describe('uploadedRowsSince', () => {
	it('bounds at the earliest capture time, minus two days of slack', () => {
		const since = uploadedRowsSince(['20260926-142026-67ef81', '20260901-080000-aaaaaa']);
		const expected = new Date(2026, 8, 1, 8, 0, 0).getTime() - 2 * 24 * 3600 * 1000;
		expect(since).toBe(new Date(expected).toISOString());
	});

	it('does not narrow when any id lacks a leading timestamp', () => {
		expect(uploadedRowsSince(['20260926-142026-67ef81', 'imported-capture'])).toBeNull();
	});

	it('has no bound for an empty list', () => {
		expect(uploadedRowsSince([])).toBeNull();
	});
});

describe('matchUploaded', () => {
	it('matches rows to local capture ids by recorded_metadata.capture_id', () => {
		const rows = [
			{ operation_id: 'op-1', recorded_metadata: { capture_id: 'cap-a' } },
			{ operation_id: 'op-2', recorded_metadata: { capture_id: 'cap-elsewhere' } },
			{ operation_id: 'op-3', recorded_metadata: { sample_name: 'no capture id' } },
			{ operation_id: 'op-4', recorded_metadata: null },
			{ operation_id: 'op-5', recorded_metadata: { capture_id: 42 } },
		];
		expect(matchUploaded(rows, ['cap-a', 'cap-b'])).toEqual({
			uploaded: { 'cap-a': true },
			opIds: { 'cap-a': 'op-1' },
		});
	});

	it('marks a capture uploaded even when its row has no operation id', () => {
		const { uploaded, opIds } = matchUploaded([{ recorded_metadata: { capture_id: 'cap-a' } }], ['cap-a']);
		expect(uploaded).toEqual({ 'cap-a': true });
		expect(opIds).toEqual({});
	});
});
