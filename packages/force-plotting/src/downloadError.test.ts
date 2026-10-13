import { describe, expect, it } from 'vitest';
import { downloadFailureMessage } from './downloadError';

const http = (status: number) => ({ message: `Request failed with status code ${status}`, response: { status } });

describe('downloadFailureMessage', () => {
	it('an expired session says to sign in again, not the raw axios text', () => {
		expect(downloadFailureMessage(http(401))).toBe('Your session expired. Reload the page to sign in again.');
		expect(downloadFailureMessage(http(403))).toBe('Your session expired. Reload the page to sign in again.');
	});
	it('a missing file says so', () => {
		expect(downloadFailureMessage(http(404))).toBe('That file is no longer available.');
	});
	it('anything else is a short, plain failure', () => {
		expect(downloadFailureMessage(http(500))).toBe('The download failed. Try again in a moment.');
		expect(downloadFailureMessage(new Error('Network Error'))).toBe('The download failed. Try again in a moment.');
		expect(downloadFailureMessage(undefined)).toBe('The download failed. Try again in a moment.');
	});
});
