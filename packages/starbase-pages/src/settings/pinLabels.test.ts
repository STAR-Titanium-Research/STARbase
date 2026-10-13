import { describe, expect, it } from 'vitest';
import { unavailableLabel } from './pinLabels';

describe('unavailableLabel', () => {
	it('names the kind and the target', () => {
		expect(unavailableLabel({ kind: 'page', target: '/home/labels' })).toBe('Page /home/labels');
		expect(unavailableLabel({ kind: 'view', target: '12' })).toBe('Saved view 12');
	});
	it('shortens a record id', () => {
		expect(unavailableLabel({ kind: 'record', target: 'physical_samples:3f2a9c10-1111-2222-3333-444455556666' })).toBe('Record physical_samples 3f2a9c10…');
		expect(unavailableLabel({ kind: 'record', target: 'physical_samples:7' })).toBe('Record physical_samples 7');
	});
});
