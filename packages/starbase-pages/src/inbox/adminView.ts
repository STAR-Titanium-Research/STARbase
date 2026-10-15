// How the Inbox crawler tab of /crawler shows its numbers (admins only): the daemon in a few words, its facts, the folders under Users/ and Shared/
// that match no one, and the people with no uni alias. Plain functions (no Vue, no network) so they can be tested.
import type { Fact, Tone } from '@d1/ui';
import type { CrawlerStatus, PersonWithoutAlias } from './inboxApi';

/**
 * d1-inbox calls the daemon stale after 5 minutes without a heartbeat. The crawler beats every 30 s when idle and every 5 s while it scans
 * (scripts/inbox_crawler/daemon.py tick_s, scan.py _ACTIVITY_EVERY_S), so a live daemon never comes near it and the verdict does not flap.
 */
export const INBOX_HEARTBEAT_MAX_MS = 5 * 60_000;

/** Is the daemon running (paused counts: it still beats)? The endpoint's own verdict (status.daemon) wins; without one, the heartbeat decides. */
export function isOnline(s: Pick<CrawlerStatus, 'last_heartbeat_at'> & Partial<Pick<CrawlerStatus, 'daemon'>> | null | undefined, now: number = Date.now()): boolean {
	if (!s) return false;
	if (s.daemon === 'alive' || s.daemon === 'paused') return true;
	if (s.daemon === 'stale' || s.daemon === 'never') return false;
	if (!s.last_heartbeat_at) return false;
	const t = Date.parse(s.last_heartbeat_at);
	return !Number.isNaN(t) && now - t < INBOX_HEARTBEAT_MAX_MS;
}

export interface DaemonView {
	label: string;
	tone: Tone;
}

/** Offline (no recent heartbeat), not started yet, or online and running / paused. */
export function daemonView(s: CrawlerStatus | null, now: number = Date.now()): DaemonView {
	if (s?.daemon === 'never' || (!s?.daemon && !s?.last_heartbeat_at)) return { label: 'Not started yet', tone: 'warning' };
	if (!isOnline(s, now)) return { label: 'Offline', tone: 'danger' };
	return s?.daemon === 'paused' || (!s?.daemon && s?.desired_state === 'paused') ? { label: 'Online, paused', tone: 'warning' } : { label: 'Online, running', tone: 'success' };
}

/** "12 Oct 2026, 14:05", or a dash when there is none. */
export function whenText(iso: string | null | undefined): string {
	if (!iso) return '—';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '—';
	return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const intervalText = (minutes: number | null): string => (minutes === null ? '—' : minutes === 1 ? 'every minute' : `every ${minutes} minutes`);

const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

export function adminFacts(s: CrawlerStatus | null): Fact[] {
	return [
		{ label: 'Desired state', value: dash(s?.desired_state) },
		{ label: 'Heartbeat', value: whenText(s?.last_heartbeat_at) },
		{ label: 'Started', value: whenText(s?.daemon_started_at) },
		{ label: 'Activity', value: dash(s?.current_activity), mono: !!s?.current_activity },
		{ label: 'Scans', value: intervalText(s?.interval_minutes ?? null) },
		{ label: 'Last scan started', value: whenText(s?.last_scan_started_at) },
		{ label: 'Last scan finished', value: whenText(s?.last_scan_finished_at) },
		{ label: 'Files registered', value: (s?.files_registered ?? 0).toLocaleString('en-GB') },
		{ label: 'Errors', value: String(s?.error_count ?? 0) },
	];
}

/** A scan that started and did not finish: it is running now, or the daemon stopped in the middle of it. */
export function scanState(s: CrawlerStatus | null, now: number = Date.now()): 'never' | 'running' | 'done' | 'interrupted' {
	const started = s?.last_scan_started_at ? Date.parse(s.last_scan_started_at) : NaN;
	const finished = s?.last_scan_finished_at ? Date.parse(s.last_scan_finished_at) : NaN;
	if (Number.isNaN(started) && Number.isNaN(finished)) return 'never';
	if (!Number.isNaN(finished) && (Number.isNaN(started) || finished >= started)) return 'done';
	return isOnline(s, now) ? 'running' : 'interrupted';
}

export interface UnmatchedRow {
	path: string;
	/** 'Users' (no person has this uni alias), 'Shared' (no team has this share folder) or 'other'. */
	area: 'Users' | 'Shared' | 'other';
	name: string;
	hint: string;
}

/** The folders no one owns, as rows with what to do about each. They are never scanned. */
export function unmatchedRows(folders: readonly string[]): UnmatchedRow[] {
	return folders.map((path) => {
		const [area, ...rest] = path.split('/');
		const name = rest.join('/') || path;
		if (area === 'Users') return { path, area: 'Users' as const, name, hint: 'No person has this uni alias. Set it on the People page to scan this folder.' };
		if (area === 'Shared') return { path, area: 'Shared' as const, name, hint: 'No team has this share folder. Set it on the team to scan this folder.' };
		return { path, area: 'other' as const, name: path, hint: 'Not matched to anyone.' };
	});
}

export interface AliasRow {
	id: string;
	name: string;
	note: string;
	/** The People page opened on this person (it has no per-person route: it opens searched for the name). */
	to: string;
}

/** The people with no uni alias, by name; a Former person is noted, since a Former person is not scanned in any case. */
export function aliasRows(people: readonly PersonWithoutAlias[]): AliasRow[] {
	return [...people]
		.sort((a, b) => a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' }))
		.map((p) => ({ id: p.person_id, name: p.full_name || 'Unnamed', note: [p.active ? '' : 'Former', p.has_login ? '' : 'no login yet'].filter(Boolean).join(', '), to: `/home/people?q=${encodeURIComponent(p.full_name)}` }));
}

export const SCAN_ALL_TEXT = 'Scan of every folder requested. It starts within about 30 seconds.';
