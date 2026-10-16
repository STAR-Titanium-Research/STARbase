import { describe, expect, it, vi } from 'vitest';
import { probeWebGL2 } from './webgl2';

const canvasWith = (getContext: (type: string) => unknown) => (() => ({ getContext }) as unknown as HTMLCanvasElement);

describe('probeWebGL2', () => {
	it('is true when a webgl2 context comes back, and releases it', () => {
		const lose = vi.fn();
		const gl = { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: lose } : null) };
		expect(probeWebGL2(canvasWith((t) => (t === 'webgl2' ? gl : null)))).toBe(true);
		expect(lose).toHaveBeenCalled();
	});
	it('is false for a browser with WebGL1 only (webgl answers, webgl2 does not)', () => {
		const asked: string[] = [];
		const ok = probeWebGL2(canvasWith((t) => { asked.push(t); return t === 'webgl' || t === 'experimental-webgl' ? {} : null; }));
		expect(ok).toBe(false);
		expect(asked).toEqual(['webgl2']);
	});
	it('is false when asking throws or there is no canvas', () => {
		expect(probeWebGL2(canvasWith(() => { throw new Error('blocked'); }))).toBe(false);
		expect(probeWebGL2(() => { throw new Error('no document'); })).toBe(false);
	});
});
