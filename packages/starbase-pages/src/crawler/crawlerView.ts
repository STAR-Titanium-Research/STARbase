// How the Force Crawler page shows its numbers: the words, tones and icons of the queue states and the
// daemon, and the rows of the daemon's fact list. Plain functions (no Vue, no network) so they can be tested.
// The queue states use the shared force vocabulary of @d1/ui (status.ts), so "done" reads "Analysed" here as
// it does on a sample or an operation, in the same colours.
import { statusStyle, type Fact, type Tone } from '@d1/ui';
import { fmtTime, opLabel } from './crawlerModel';

export interface StatTileView {
	key: string;
	label: string;
	value: number;
	tone: Tone;
	icon: string;
}

const STAT_ICON: Record<string, string> = {
	pending: 'schedule',
	processing: 'autorenew',
	done: 'check_circle',
	error: 'error',
	skipped: 'skip_next',
};

/** One tile per queue state, in the given order. A state with no rows counts 0. */
export function statTiles(order: readonly string[], counts: Record<string, number>): StatTileView[] {
	return order.map((key) => {
		const style = statusStyle('force', key);
		return { key, label: style?.label ?? key, value: counts[key] ?? 0, tone: style?.tone ?? 'neutral', icon: STAT_ICON[key] ?? 'circle' };
	});
}

/** Whether a tile's figure is drawn in its tone: only a state that wants looking at, and only when it is not empty. */
export const toneWorthShowing = (t: StatTileView): boolean => t.value > 0 && (t.tone === 'danger' || t.tone === 'progress');

export interface DaemonView {
	label: string;
	tone: Tone;
}

/** The daemon in a few words: offline (no recent heartbeat), or online and running / paused. */
export function daemonView(online: boolean, running: boolean): DaemonView {
	if (!online) return { label: 'Offline', tone: 'danger' };
	return running ? { label: 'Online, running', tone: 'success' } : { label: 'Online, paused', tone: 'warning' };
}

/** The button's word follows the desired state: a running daemon is paused, anything else is started. */
export const toggleLabel = (running: boolean): string => (running ? 'Pause' : 'Start');

/** The daemon's facts, as the shared fact list takes them. A column the row lacks reads as a dash. */
export function daemonFacts(state: Record<string, any> | null): Fact[] {
	const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
	return [
		{ label: 'Desired state', value: dash(state?.desired_state) },
		{ label: 'PID', value: dash(state?.daemon_pid), mono: true },
		{ label: 'Started', value: fmtTime(state?.daemon_started_at) },
		{ label: 'Heartbeat', value: fmtTime(state?.last_heartbeat_at) },
		{ label: 'Last discover', value: fmtTime(state?.last_discover_at) },
		{ label: 'Activity', value: dash(state?.current_activity), mono: !!state?.current_activity },
		{ label: 'Session done / errors', value: `${state?.processed_count ?? 0} / ${state?.error_count ?? 0}` },
	];
}

export interface QueueRow {
	id: string;
	label: string;
	status: string;
	message: string | null;
	time: string;
}

/** A row of the errors or the recent-activity table: what to call the file, its status, its message and when. */
export function queueRow(r: { id: string; status?: string; error_message?: string | null; updated_at?: string | null; operation_id?: any }): QueueRow {
	return { id: r.id, label: opLabel(r), status: r.status ?? 'error', message: r.error_message || null, time: fmtTime(r.updated_at) };
}

export const filesText = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;
