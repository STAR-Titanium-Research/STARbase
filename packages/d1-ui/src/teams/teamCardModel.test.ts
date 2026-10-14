import { describe, expect, it } from 'vitest';
import { cardStatus, triggerAttrs } from './teamCardModel';

describe('triggerAttrs', () => {
	it('says a card is closed, without pointing at a popover that is not there', () => {
		expect(triggerAttrs(false, 'pop-1')).toEqual({ 'aria-expanded': false });
		expect('aria-controls' in triggerAttrs(false, 'pop-1')).toBe(false);
	});
	it('says it is open and which element it controls', () => {
		expect(triggerAttrs(true, 'pop-1')).toEqual({ 'aria-expanded': true, 'aria-controls': 'pop-1' });
	});
});

describe('cardStatus', () => {
	it('says it is loading, then what the team is, or why it failed', () => {
		expect(cardStatus(null, 0, '')).toBe('Loading the team…');
		expect(cardStatus({ name: 'Sintering' }, 3, '')).toBe('Sintering, 3 members');
		expect(cardStatus({ name: 'Sintering' }, 1, '')).toBe('Sintering, 1 member');
		expect(cardStatus(null, 0, 'Could not read the team.')).toBe('Could not read the team.');
	});
});
