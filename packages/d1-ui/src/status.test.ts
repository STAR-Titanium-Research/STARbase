import { describe, expect, it } from 'vitest';
import {
	CAMPAIGN_STATUS, DIAG_STATUS, FORCE_STATUS, SAMPLE_STATUS, TEST_DONE_STATUSES, TEST_GLYPH, TEST_RANK, TEST_STATUS,
	TEST_STATUS_ORDER, humanise, statusStyle,
} from './status';

describe('vocabularies', () => {
	it('covers the whole test-session lifecycle', () => {
		expect(Object.keys(TEST_STATUS)).toEqual([
			'registered',
			'pending_processing',
			'processing',
			'processed',
			'analysing',
			'analysed',
			'failed',
		]);
	});

	it('covers the force work-queue states', () => {
		expect(Object.keys(FORCE_STATUS)).toEqual(['pending', 'processing', 'done', 'error', 'skipped']);
	});

	it('covers the diagnostics states (null means not requested)', () => {
		expect(Object.keys(DIAG_STATUS)).toEqual(['pending', 'processing', 'done', 'error']);
	});

	it('covers the sample statuses', () => {
		expect(Object.keys(SAMPLE_STATUS)).toEqual(['active', 'consumed', 'destroyed', 'archived']);
	});

	it('marks failures as danger and finished work as success', () => {
		expect(TEST_STATUS.failed.tone).toBe('danger');
		expect(FORCE_STATUS.error.tone).toBe('danger');
		expect(TEST_STATUS.analysed.tone).toBe('success');
		expect(FORCE_STATUS.done.tone).toBe('success');
	});
});

describe('statusStyle', () => {
	it('looks a value up in the right vocabulary', () => {
		expect(statusStyle('test', 'pending_processing')).toEqual({ label: 'Pending processing', tone: 'info' });
		expect(statusStyle('force', 'done')?.label).toBe('Analysed');
		expect(statusStyle('diag', 'done')?.label).toBe('Diagnostics built');
		expect(statusStyle('sample', 'consumed')?.tone).toBe('warning');
	});

	it('returns null for a missing value', () => {
		expect(statusStyle('test', null)).toBeNull();
		expect(statusStyle('test', undefined)).toBeNull();
		expect(statusStyle('diag', '')).toBeNull();
	});

	it('shows an unknown value in neutral rather than hiding it', () => {
		expect(statusStyle('test', 'on_hold')).toEqual({ label: 'On hold', tone: 'neutral' });
	});
});

describe('humanise', () => {
	it('capitalises and replaces underscores', () => {
		expect(humanise('heat_treatment')).toBe('Heat treatment');
		expect(humanise('')).toBe('');
	});
});

describe('the test lifecycle is defined once', () => {
	it('derives every list from the same statuses', () => {
		const statuses = Object.keys(TEST_STATUS);
		expect(TEST_STATUS_ORDER).toEqual(statuses);
		expect(Object.keys(TEST_RANK)).toEqual(statuses);
		expect(Object.keys(TEST_GLYPH)).toEqual(statuses);
	});
	it('counts processed and analysed as done, nothing else', () => {
		expect(TEST_DONE_STATUSES).toEqual(['processed', 'analysed']);
	});
	it('ranks failed worst and analysed most advanced', () => {
		const byRank = [...TEST_STATUS_ORDER].sort((a, b) => TEST_RANK[a] - TEST_RANK[b]);
		expect(byRank[0]).toBe('failed');
		expect(byRank[byRank.length - 1]).toBe('analysed');
	});
	it('gives done statuses a tick and failures a bang', () => {
		expect(TEST_GLYPH.analysed).toBe('✓');
		expect(TEST_GLYPH.failed).toBe('!');
	});
});

describe('campaign status', () => {
	it('colours the known values', () => {
		expect(statusStyle('campaign', 'on_hold')).toEqual({ label: 'On hold', tone: 'warning' });
		expect(CAMPAIGN_STATUS.active.tone).toBe('success');
	});
	it('shows an unknown free-text value humanised and neutral', () => {
		expect(statusStyle('campaign', 'in_review')).toEqual({ label: 'In review', tone: 'neutral' });
	});
});
