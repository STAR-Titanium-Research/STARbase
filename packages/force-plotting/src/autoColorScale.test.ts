import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { useAutoColorScale } from './autoColorScale';

describe('useAutoColorScale', () => {
	it('follows reported ranges while unlocked', () => {
		const a = useAutoColorScale();
		a.onClimits({ cmin: -20, cmax: 30 });
		expect([a.colorScale.value.satMin, a.colorScale.value.satMax]).toEqual([-20, 30]);
		a.onClimits({ cmin: -50, cmax: 60 });
		expect([a.colorScale.value.satMin, a.colorScale.value.satMax]).toEqual([-50, 60]);
	});

	it('ignores a value-identical re-report (no fresh scale object)', () => {
		const a = useAutoColorScale();
		a.onClimits({ cmin: 1, cmax: 2 });
		const before = a.colorScale.value;
		a.onClimits({ cmin: 1, cmax: 2 });
		expect(a.colorScale.value).toBe(before);
	});

	it('keeps the saturation range while locked, and re-applies the latest auto range on unlock', async () => {
		const a = useAutoColorScale();
		a.onClimits({ cmin: 0, cmax: 10 });
		a.locked.value = true;
		await nextTick();
		a.onClimits({ cmin: 0, cmax: 120 });
		expect(a.colorScale.value.satMax).toBe(10);
		a.locked.value = false;
		await nextTick();
		expect(a.colorScale.value.satMax).toBe(120);
	});

	it('keeps shaping params like symmetrical when re-seeding', () => {
		const a = useAutoColorScale();
		a.colorScale.value = { ...a.colorScale.value, symmetrical: true };
		a.onClimits({ cmin: -20, cmax: 30 });
		expect([a.colorScale.value.satMin, a.colorScale.value.satMax]).toEqual([-30, 30]);
	});

	it('falls back to the supplied range on unlock when nothing has been reported', async () => {
		const a = useAutoColorScale({ fallback: () => [5, 50] });
		a.locked.value = true;
		await nextTick();
		a.locked.value = false;
		await nextTick();
		expect([a.colorScale.value.satMin, a.colorScale.value.satMax]).toEqual([5, 50]);
	});
});
