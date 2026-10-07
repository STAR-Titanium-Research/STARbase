import { describe, expect, it } from 'vitest';
import { useRequestGate } from './useRequestGate';

describe('useRequestGate', () => {
	it('only the latest begin() is current', () => {
		const gate = useRequestGate();
		const first = gate.begin();
		expect(gate.isCurrent(first)).toBe(true);
		const second = gate.begin();
		expect(gate.isCurrent(first)).toBe(false);
		expect(gate.isCurrent(second)).toBe(true);
	});

	it('cancel() drops the in-flight request', () => {
		const gate = useRequestGate();
		const token = gate.begin();
		gate.cancel();
		expect(gate.isCurrent(token)).toBe(false);
	});

	it('gates are independent', () => {
		const a = useRequestGate();
		const b = useRequestGate();
		const ta = a.begin();
		b.begin();
		b.begin();
		expect(a.isCurrent(ta)).toBe(true);
	});
});
