import { describe, expect, it } from 'vitest';
import { isLocalRecorderUrl } from './localPaths';

describe('isLocalRecorderUrl', () => {
	it('accepts the loopback addresses the desktop app and dev setups use', () => {
		expect(isLocalRecorderUrl('http://127.0.0.1:8200')).toBe(true);
		expect(isLocalRecorderUrl('http://localhost:8200')).toBe(true);
		expect(isLocalRecorderUrl('http://[::1]:8200')).toBe(true);
	});

	it('rejects a recorder on another machine, and garbage', () => {
		expect(isLocalRecorderUrl('http://192.168.1.20:8200')).toBe(false);
		expect(isLocalRecorderUrl('https://rig-pc.tail54eeb6.ts.net/recorder')).toBe(false);
		expect(isLocalRecorderUrl('http://localhost.evil.example:8200')).toBe(false);
		expect(isLocalRecorderUrl('not a url')).toBe(false);
	});
});
