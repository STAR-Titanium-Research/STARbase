import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { queueUpload } from './frmUpload';

function attrs(n = 100) {
	return { pos: new THREE.BufferAttribute(new Float32Array(n * 3), 3), val: new THREE.BufferAttribute(new Float32Array(n), 1) };
}

describe('queueUpload (#87)', () => {
	it('queues just the new slice when nothing is pending', () => {
		const { pos, val } = attrs();
		queueUpload(pos, val, 10, 20);
		expect(val.updateRanges).toEqual([{ start: 10, count: 10 }]);
		expect(pos.updateRanges).toEqual([{ start: 30, count: 30 }]);
	});

	it('keeps slices written while no upload happened, as one union range', () => {
		const { pos, val } = attrs();
		queueUpload(pos, val, 10, 20);
		// No render in between (e.g. the object was culled): three never cleared the ranges.
		queueUpload(pos, val, 20, 35);
		queueUpload(pos, val, 35, 40);
		expect(val.updateRanges).toEqual([{ start: 10, count: 30 }]);
		expect(pos.updateRanges).toEqual([{ start: 30, count: 90 }]);
	});

	it('starts afresh once three has uploaded (and cleared) the ranges', () => {
		const { pos, val } = attrs();
		queueUpload(pos, val, 10, 20);
		pos.clearUpdateRanges(); val.clearUpdateRanges();   // what updateBuffer does after upload
		queueUpload(pos, val, 20, 25);
		expect(val.updateRanges).toEqual([{ start: 20, count: 5 }]);
	});

	it('covers a rewrite from slot 0 after a reset', () => {
		const { pos, val } = attrs();
		queueUpload(pos, val, 50, 60);
		queueUpload(pos, val, 0, 5);
		expect(val.updateRanges).toEqual([{ start: 0, count: 5 }]);
	});

	it('ignores an empty slice', () => {
		const { pos, val } = attrs();
		queueUpload(pos, val, 5, 5);
		expect(val.updateRanges).toEqual([]);
	});
});
