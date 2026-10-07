import { describe, expect, it } from 'vitest';
import { shouldOpenSaveDialog } from './saveDialogGate';

describe('shouldOpenSaveDialog', () => {
	it('opens when a recording ends, however it ends', () => {
		for (const s of ['finalizing', 'done', 'error'] as const) expect(shouldOpenSaveDialog(s, 'recording')).toBe(true);
	});
	it('opens for a finalizing cut adopted onto an idle (or settled) client after a reload', () => {
		expect(shouldOpenSaveDialog('finalizing', 'idle')).toBe(true);
		expect(shouldOpenSaveDialog('finalizing', 'done')).toBe(true);
		expect(shouldOpenSaveDialog('finalizing', undefined)).toBe(true);
	});
	it('does not reopen when finalizing ends: the operator may have dismissed the dialog', () => {
		expect(shouldOpenSaveDialog('done', 'finalizing')).toBe(false);
		expect(shouldOpenSaveDialog('error', 'finalizing')).toBe(false);
	});
	it('does not open for a run that merely starts or goes idle', () => {
		expect(shouldOpenSaveDialog('recording', 'idle')).toBe(false);
		expect(shouldOpenSaveDialog('idle', 'done')).toBe(false);
		expect(shouldOpenSaveDialog('done', 'idle')).toBe(false);
	});
});
