// Wording and gating for the remote-backup list (#91, and the cross-link half of #31).
//
// The backup server's own `state` only says how far the STREAM got — "complete" means /ingest/finish
// arrived, not "this recording is fine" — so the list shows what the backend derived from it
// (`backup_state`) plus what this machine still holds (`local_status`).

export interface RemoteSession {
	id: string;
	/** Display name (the recording's sample_name), when known. */
	name?: string | null;
	/** Raw server stream state; prefer backup_state. */
	state?: string;
	backup_state?: 'complete' | 'interrupted' | 'streaming' | 'deleted' | 'unknown';
	local_status?: 'finalized' | 'incomplete' | 'recording' | 'missing' | 'deleted';
	/** Unix seconds at which the server's retention sweep removes this backup. */
	expires_at?: number | null;
	raw_size_mb: number;
	duration_sec?: number;
	started_iso?: string;
	n_rows?: number;
	rate?: number;
}

/** "in 5h", "in 40 min", "within a minute" — or "now" once it is due. */
export function expiresIn(expiresAt: number | null | undefined, nowMs: number = Date.now()): string | null {
	if (expiresAt == null) return null;
	const sec = expiresAt - nowMs / 1000;
	if (sec <= 60) return sec <= 0 ? 'now' : 'within a minute';
	if (sec < 3600) return `in ${Math.round(sec / 60)} min`;
	const h = sec / 3600;
	return `in ${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
}

export interface StateLabel {
	text: string;
	/** CSS modifier: ok | warn | dim. */
	tone: 'ok' | 'warn' | 'dim';
	title: string;
}

export function backupStateLabel(s: RemoteSession, nowMs: number = Date.now()): StateLabel {
	switch (s.backup_state) {
		case 'complete':
			return { text: 'Fully backed up', tone: 'ok', title: 'The whole recording reached the backup server.' };
		case 'interrupted':
			return {
				text: 'Backup interrupted (partial)', tone: 'warn',
				title: 'The stream stopped before the recording ended (crash, network loss, app closed). Only the part sent so far is here.',
			};
		case 'streaming':
			return { text: 'Recording now…', tone: 'dim', title: 'This recording is still being streamed.' };
		case 'deleted': {
			const left = expiresIn(s.expires_at, nowMs);
			return {
				text: left ? `Deleted locally — expires ${left}` : 'Deleted locally', tone: 'dim',
				title: 'The local copy was deleted. This backup is kept until the server\'s retention runs out, so the deletion can still be undone by restoring it.',
			};
		}
		default:
			return { text: s.state || 'Unknown', tone: 'dim', title: 'State reported by the backup server.' };
	}
}

/** The remote copy of a capture, in words. `state` is its backup_state, or null/undefined when the
 *  server holds nothing for it; 'complete' is the whole recording, anything else only a partial one. */
export function remoteCopyLabel(state: string | null | undefined): string {
	if (state == null) return 'no remote copy';
	return state === 'complete' ? 'remote copy exists' : 'partial remote copy';
}

/** What this machine holds for the capture, in words — shown beside the backup state. */
export function localStatusLabel(s: RemoteSession): string | null {
	switch (s.local_status) {
		case 'finalized': return 'Also saved on this machine';
		case 'incomplete': return 'Local copy incomplete — recover it in Local Captures';
		case 'recording': return 'Being recorded on this machine';
		case 'missing': return 'Not on this machine';
		default: return null; // 'deleted' is already said by the backup label
	}
}

/** Why Restore is unavailable for this row, or null when it can be used. The backend refuses with
 *  a 409 too — this just says so before the click. */
export function restoreBlockedReason(s: RemoteSession): string | null {
	if (s.local_status === 'finalized') return 'This recording is already saved on this machine. Delete the local copy first (Settings > Local Captures) to restore the backup.';
	if (s.local_status === 'recording' || s.backup_state === 'streaming') return 'This recording is still in progress.';
	// The backup is usually the SHORTER copy of a crashed recording, so restoring it over local
	// data risks trading minutes of recording for fewer. Recover the local one instead (the backend
	// refuses too, and only replaces a local raw when the backup is strictly larger).
	if (s.local_status === 'incomplete') return 'An incomplete copy of this recording is on this machine. Recover it from Settings > Local Captures — restoring the backup could replace it with a shorter one.';
	return null;
}

/** Remote rows that have no local copy left to compare with: worth restoring. */
export function isRestorable(s: RemoteSession): boolean {
	return restoreBlockedReason(s) === null;
}

/** The three list outcomes the UI must not conflate (#92). */
export type ListState = 'idle' | 'loading' | 'error' | 'empty' | 'ready';
export function listState(o: { loaded: boolean; loading: boolean; error: string; count: number }): ListState {
	if (o.error) return 'error';
	if (o.loading && !o.loaded) return 'loading';
	if (!o.loaded) return 'idle';
	return o.count ? 'ready' : 'empty';
}

/** Fills an empty backup URL with the backend's suggested one (#135). `suggested` is true when the
 *  returned URL is only a proposal that is not saved yet; a URL the user already saved is kept. */
export function prefillServerUrl(current: string | null | undefined, suggested: string | null | undefined): { url: string; suggested: boolean } {
	const cur = (current ?? '').trim();
	if (cur) return { url: cur, suggested: false };
	const sug = (suggested ?? '').trim();
	return sug ? { url: sug, suggested: true } : { url: '', suggested: false };
}

/** The URL a Save should send. While the field still shows the untouched suggestion and backups are
 *  off, nothing is saved (''), so a Save that only leaves backups disabled can't make the Doctor probe
 *  a server the rig may not have (#135). Enabling backups, or editing the field, makes it a real value. */
export function serverUrlToSave(cfg: { enabled: boolean; server_url: string }, isSuggestion: boolean): string {
	return isSuggestion && !cfg.enabled ? '' : cfg.server_url;
}
