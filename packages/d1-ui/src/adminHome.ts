// The pure rules behind the admin Home (core/extensions/d1-home/src/home): what the admin overview
// endpoint's JSON means, when the crawler counts as online, which "Needs attention" rows show and
// what an ownerless row links to. No Vue and no SDK, so it is unit-tested here.
//
// The endpoint is core/extensions/d1-admin-overview (GET /d1-admin-overview). Any part of its answer
// can be null (that part's query failed), so every reader below treats a missing part as "could not
// load", never as zero.

import { collectionRoute } from './recordRoute';

/** The crawler counts as online when its heartbeat is younger than this. */
export const CRAWLER_ONLINE_MS = 30_000;

export interface MissingFiles { count: number; recent: { id: string; filename_download: string | null; missing_since: string | null }[] }
export interface Fingerprints { done: number; error: number; missing: number }
export interface CrawlerState {
	desired_state: string | null;
	current_activity: string | null;
	last_heartbeat_at: string | null;
	processed_count: number;
	error_count: number;
}
export interface Crawler { state: CrawlerState | null; analyses: { pending: number; processing: number; done: number; error: number } }
export interface Ownerless { samples: number; campaigns: number; machiningOperations: number }
export interface AdminOverview {
	missingFiles: MissingFiles | null;
	fingerprints: Fingerprints | null;
	crawler: Crawler | null;
	ownerless: Ownerless | null;
	/** The database's clock when the answer was made (ISO), or null. The reference for "online" and "x ago". */
	serverTime: string | null;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The endpoint's JSON as an AdminOverview, or null when it is not an object at all. A part that is not an object becomes null. */
export function normaliseOverview(raw: unknown): AdminOverview | null {
	if (!isObj(raw)) return null;
	const mf = isObj(raw.missingFiles)
		? {
			count: num(raw.missingFiles.count),
			recent: (Array.isArray(raw.missingFiles.recent) ? raw.missingFiles.recent : []).filter(isObj).map((r) => ({
				id: String(r.id), filename_download: str(r.filename_download), missing_since: str(r.missing_since),
			})),
		}
		: null;
	const fp = isObj(raw.fingerprints)
		? { done: num(raw.fingerprints.done), error: num(raw.fingerprints.error), missing: num(raw.fingerprints.missing) }
		: null;
	let crawler: Crawler | null = null;
	if (isObj(raw.crawler)) {
		const s = raw.crawler.state;
		const a = isObj(raw.crawler.analyses) ? raw.crawler.analyses : {};
		crawler = {
			state: isObj(s)
				? {
					desired_state: str(s.desired_state), current_activity: str(s.current_activity),
					last_heartbeat_at: str(s.last_heartbeat_at), processed_count: num(s.processed_count), error_count: num(s.error_count),
				}
				: null,
			analyses: { pending: num(a.pending), processing: num(a.processing), done: num(a.done), error: num(a.error) },
		};
	}
	const ol = isObj(raw.ownerless)
		? { samples: num(raw.ownerless.samples), campaigns: num(raw.ownerless.campaigns), machiningOperations: num(raw.ownerless.machiningOperations) }
		: null;
	return { missingFiles: mf, fingerprints: fp, crawler, ownerless: ol, serverTime: str(raw.serverTime) };
}

/** A heartbeat further ahead of the reference than this is a mis-set clock, not a live crawler. */
export const FUTURE_TOLERANCE_MS = 120_000;

/**
 * Online = a heartbeat younger than 30 s against `now`, which should be the database's clock
 * (`overviewTime`), the one the heartbeat is stamped with. A missing or unreadable heartbeat is offline;
 * one slightly ahead (clock jitter) counts as just now, one more than 2 minutes ahead is offline.
 */
export function crawlerOnline(lastHeartbeatAt: string | null | undefined, now: number = Date.now()): boolean {
	if (!lastHeartbeatAt) return false;
	const t = new Date(lastHeartbeatAt).getTime();
	if (Number.isNaN(t)) return false;
	const age = now - t;
	return age < CRAWLER_ONLINE_MS && age > -FUTURE_TOLERANCE_MS;
}

/**
 * The time to judge the data against, in ms: the database's clock as of the answer (`serverTime`; the
 * browser's `fetchedAt` when it is missing or unreadable), plus the time passed since the answer
 * arrived when `now` is given. Without `now` it is the moment of the answer itself, which is what
 * "online" uses: that verdict is fixed per answer, so it cannot drift to Offline between refreshes.
 */
export function overviewTime(serverTime: string | null | undefined, fetchedAt: number, now: number = fetchedAt): number {
	const server = serverTime ? new Date(serverTime).getTime() : NaN;
	return (Number.isNaN(server) ? fetchedAt : server) + Math.max(0, now - fetchedAt);
}

/** True for a 401 or 403: the caller is not an admin (or not signed in), which is silence, not an error. */
export function isAuthRefusal(e: any): boolean {
	const status = e?.response?.status;
	return status === 401 || status === 403;
}

/** "12 s ago", "5 min ago", "3 h ago", "2 d ago"; '' when the time is missing or unreadable. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return '';
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return '';
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return `${s} s ago`;
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86_400)} d ago`;
}

export interface OwnerlessRow { key: string; label: string; count: number; to: string }

/**
 * The ownerless panel's rows. Each links to its Explorer list: the index pages have no "no owner"
 * chip, so these are the plain lists. `machiningOperations` is machining only (the endpoint leaves the
 * legacy FAST imports out), which the label says.
 */
export function ownerlessRows(o: Ownerless): OwnerlessRow[] {
	return [
		{ key: 'samples', label: 'Samples', count: o.samples, to: collectionRoute('physical_samples') },
		{ key: 'campaigns', label: 'Campaigns', count: o.campaigns, to: collectionRoute('campaigns') },
		{ key: 'operations', label: 'Machining operations', count: o.machiningOperations, to: collectionRoute('manufacturing_operations') },
	];
}

export const ownerlessTotal = (o: Ownerless): number => o.samples + o.campaigns + o.machiningOperations;

export interface AttentionTile { key: string; count: number | null; error: string; loading: boolean }

/**
 * What the Needs attention panel shows. `rows` are the keys to list: a tile with a count above zero,
 * or, when `showErrors`, one that failed (an admin sees a failure, not zero; a member whose role cannot read
 * a collection is not shown a permanent error row for it). `status` is 'loading' while no row is
 * known yet and a count is still coming, 'clear' when every tile answered with nothing, else 'items'.
 */
export function attentionView(tiles: AttentionTile[], showErrors = true): { rows: string[]; status: 'loading' | 'clear' | 'items' } {
	const rows = tiles.filter((t) => !t.loading && ((showErrors && t.error !== '') || (t.count ?? 0) > 0)).map((t) => t.key);
	if (rows.length) return { rows, status: 'items' };
	return { rows, status: tiles.length === 0 || tiles.some((t) => t.loading) ? 'loading' : 'clear' };
}
