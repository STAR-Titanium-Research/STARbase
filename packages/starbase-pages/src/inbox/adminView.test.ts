import { describe, expect, it } from 'vitest';
import type { CrawlerStatus } from './inboxApi';
import { INBOX_HEARTBEAT_MAX_MS, adminFacts, aliasRows, daemonView, intervalText, isOnline, scanState, unmatchedRows, whenText } from './adminView';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const status = (over: Partial<CrawlerStatus> = {}): CrawlerStatus => ({
	desired_state: 'running', interval_minutes: 30, last_heartbeat_at: '2026-10-15T11:59:30Z', daemon_started_at: null, current_activity: null,
	last_scan_started_at: null, last_scan_finished_at: null, files_registered: 1234, error_count: 0, last_error: null, ...over,
});

describe('the daemon', () => {
	it('is online while its heartbeat is recent, and offline without one or when it is old', () => {
		expect(isOnline(status(), NOW)).toBe(true);
		expect(isOnline(status({ last_heartbeat_at: new Date(NOW - INBOX_HEARTBEAT_MAX_MS - 1).toISOString() }), NOW)).toBe(false);
		expect(isOnline(status({ last_heartbeat_at: null }), NOW)).toBe(false);
		expect(isOnline(null, NOW)).toBe(false);
		expect(isOnline(status({ last_heartbeat_at: 'not a date' }), NOW)).toBe(false);
	});
	it('reads as Offline, Online running or Online paused', () => {
		expect(daemonView(null, NOW)).toEqual({ label: 'Offline', tone: 'danger' });
		expect(daemonView(status(), NOW)).toEqual({ label: 'Online, running', tone: 'success' });
		expect(daemonView(status({ desired_state: 'paused' }), NOW)).toEqual({ label: 'Online, paused', tone: 'warning' });
	});
	it('knows a scan that never ran, is running, finished, or was cut off', () => {
		expect(scanState(status(), NOW)).toBe('never');
		expect(scanState(status({ last_scan_started_at: '2026-10-15T11:55:00Z' }), NOW)).toBe('running');
		expect(scanState(status({ last_scan_started_at: '2026-10-15T11:55:00Z', last_scan_finished_at: '2026-10-15T11:58:00Z' }), NOW)).toBe('done');
		expect(scanState(status({ last_scan_started_at: '2026-10-15T11:00:00Z', last_heartbeat_at: '2026-10-15T11:10:00Z' }), NOW)).toBe('interrupted');
	});
});

describe('facts', () => {
	it('lists the status, with a dash for what is missing', () => {
		const facts = adminFacts(status());
		expect(facts.map((f) => [f.label, f.value])).toEqual([
			['Desired state', 'running'], ['Heartbeat', whenText('2026-10-15T11:59:30Z')], ['Started', '—'], ['Activity', '—'], ['Scans', 'every 30 minutes'],
			['Last scan started', '—'], ['Last scan finished', '—'], ['Files registered', '1,234'], ['Errors', '0'],
		]);
		expect(adminFacts(null).find((f) => f.label === 'Files registered')?.value).toBe('0');
		expect(intervalText(1)).toBe('every minute');
		expect(intervalText(null)).toBe('—');
		expect(whenText('nope')).toBe('—');
	});
});

describe('folders no one owns, and people with no alias', () => {
	it('says what to do for each unmatched folder', () => {
		const rows = unmatchedRows(['Users/zz9', 'Shared/Old project', 'Misc']);
		expect(rows.map((r) => [r.area, r.name])).toEqual([['Users', 'zz9'], ['Shared', 'Old project'], ['other', 'Misc']]);
		expect(rows[0].hint).toContain('uni alias');
		expect(rows[1].hint).toContain('share folder');
	});
	it('lists people by name, notes a Former person and links to the People page searched for the name', () => {
		const rows = aliasRows([{ person_id: 'p2', full_name: 'bo Chan', active: false }, { person_id: 'p1', full_name: 'Ann Lee', active: true }]);
		expect(rows.map((r) => [r.name, r.note, r.to])).toEqual([['Ann Lee', '', '/home/people?q=Ann%20Lee'], ['bo Chan', 'Former', '/home/people?q=bo%20Chan']]);
	});
});
