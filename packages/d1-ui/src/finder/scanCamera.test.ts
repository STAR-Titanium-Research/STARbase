import { describe, expect, it } from 'vitest';
import { cameraErrorMessage, cameraSupport, decodeSize, INSECURE_MESSAGE } from './scanCamera';

describe('cameraSupport', () => {
	it('is ok on a secure page with getUserMedia', () => {
		expect(cameraSupport({ isSecureContext: true, mediaDevices: { getUserMedia: () => {} } })).toEqual({ ok: true });
	});
	it('names HTTPS when the page is not a secure context', () => {
		expect(cameraSupport({ isSecureContext: false, mediaDevices: undefined })).toEqual({ ok: false, message: INSECURE_MESSAGE });
		expect(INSECURE_MESSAGE).toContain('https://d1-server.tail54eeb6.ts.net');
	});
	it('explains a missing getUserMedia', () => {
		for (const mediaDevices of [undefined, null, {}]) {
			const r = cameraSupport({ isSecureContext: true, mediaDevices });
			expect(r.ok).toBe(false);
		}
	});
});

describe('cameraErrorMessage', () => {
	it('explains a denied permission', () => {
		expect(cameraErrorMessage({ name: 'NotAllowedError' })).toMatch(/permission was denied/);
	});
	it('explains no camera, a busy camera and anything else', () => {
		expect(cameraErrorMessage({ name: 'NotFoundError' })).toMatch(/No camera/);
		expect(cameraErrorMessage({ name: 'NotReadableError' })).toMatch(/in use/);
		expect(cameraErrorMessage(new Error('?'))).toMatch(/could not be started/);
		expect(cameraErrorMessage(null)).toMatch(/could not be started/);
	});
});

describe('decodeSize', () => {
	it('keeps a small frame and shrinks a wide one in proportion', () => {
		expect(decodeSize(320, 240)).toEqual({ width: 320, height: 240 });
		expect(decodeSize(1280, 720)).toEqual({ width: 640, height: 360 });
	});
	it('is empty before the video has a size', () => {
		expect(decodeSize(0, 0)).toEqual({ width: 0, height: 0 });
	});
});
