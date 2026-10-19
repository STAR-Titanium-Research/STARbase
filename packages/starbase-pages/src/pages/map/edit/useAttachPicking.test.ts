import { describe, expect, it } from 'vitest';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample } from '../model/fixtures';
import { ancestorSamples } from './useAttachPicking';

const draw = (data: ReturnType<typeof mkData>) => buildGraph(data, groupBatches(data.operations, data.tests, { probable: false, stack: true }), { slots: () => [] });

describe('what a sample comes from, as far as the map has loaded it', () => {
	const data = mkData({
		samples: [mkSample('a'), mkSample('b'), mkSample('c'), mkSample('lone')],
		operations: [
			mkOp({ id: 'o1', sampleId: 'a', outputSampleId: 'b', date: '2026-09-01T09:00:00Z' }),
			mkOp({ id: 'o2', sampleId: 'b', outputSampleId: 'c', date: '2026-09-02T09:00:00Z' }),
		],
	});

	it('is every sample upstream of it, not itself and not what comes after it', () => {
		const g = draw(data);
		expect([...ancestorSamples(g, 's:c')].sort()).toEqual(['a', 'b']);
		expect([...ancestorSamples(g, 's:b')]).toEqual(['a']);
		expect([...ancestorSamples(g, 's:a')]).toEqual([]);
		expect([...ancestorSamples(g, 's:lone')]).toEqual([]);
	});

	it('is nothing for a sample that is not drawn, or when nothing is', () => {
		expect([...ancestorSamples(draw(data), 's:nope')]).toEqual([]);
		expect([...ancestorSamples(null, 's:c')]).toEqual([]);
	});
});
