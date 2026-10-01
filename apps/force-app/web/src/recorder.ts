// Who recorded a cut. A recording can sit on this PC for days -- recorded offline, uploaded later,
// possibly while someone else is signed in -- and Directus attributes a write to whoever's token
// performs it. So the recording user is written INTO the capture itself (extra_metadata ->
// summary.json) when the cut starts, and every upload path reads it back from there rather than
// from whoever happens to be signed in at upload time:
//   - owner_person_id on the operation is the recorder's person, not the uploader's;
//   - recorded_metadata carries recorded_by_* so the provenance survives in the database.
// (audit_logs.actor_identity still names the account that performed the write -- that is the
// truthful "who uploaded" -- and recorded_metadata.synced_by_* repeats it beside the recorder.)
import { authStore } from './authStore';
import { api } from './directusClient';

export interface Recorder {
	userId: string;
	email: string | null;
	name: string | null;
	personId: string | null;
	/** Signed in from the on-device verifier (no server contact) when the cut was recorded. */
	offline: boolean;
}

/** Keys this module owns inside extra_metadata / recorded_metadata. All carry the `recorded_` prefix. */
export const RECORDER_PREFIX = 'recorded_';

export function currentRecorder(): Recorder | null {
	const u = authStore.state.user;
	if (!u?.id) return null;
	const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
	return {
		userId: u.id,
		email: u.email ?? null,
		name: name || null,
		personId: u.person_id ?? null,
		offline: authStore.state.offline,
	};
}

/** extra_metadata fields for a cut that starts now, as `recorder` (empty when nobody is identified). */
export function recorderFields(r: Recorder | null, recordedAt: string): Record<string, string | boolean> {
	const o: Record<string, string | boolean> = { recorded_at: recordedAt };
	if (!r) return o;
	o.recorded_by_user_id = r.userId;
	if (r.email) o.recorded_by_email = r.email;
	if (r.name) o.recorded_by_name = r.name;
	if (r.personId) o.recorded_by_person_id = r.personId;
	o.recorded_offline = r.offline;
	return o;
}

export function recorderFromExtra(extra: Record<string, any> | null | undefined): Recorder | null {
	const id = extra?.recorded_by_user_id;
	if (!id) return null;
	return {
		userId: String(id),
		email: extra?.recorded_by_email ?? null,
		name: extra?.recorded_by_name ?? null,
		personId: extra?.recorded_by_person_id ?? null,
		offline: !!extra?.recorded_offline,
	};
}

/**
 * The recorder's own keys from a metadata object -- what an editor that rewrites extra_metadata
 * wholesale must carry over untouched, or correcting a typo would erase who recorded the cut.
 */
export function preservedRecorderKeys(extra: Record<string, any> | null | undefined): Record<string, any> {
	const o: Record<string, any> = {};
	for (const [k, v] of Object.entries(extra ?? {})) if (k.startsWith(RECORDER_PREFIX)) o[k] = v;
	return o;
}

/** Who is performing this upload right now, stamped next to the recorder. */
export function syncerFields(now: number = Date.now()): Record<string, string> {
	const u = authStore.state.user;
	const o: Record<string, string> = { synced_at: new Date(now).toISOString() };
	if (u?.id) o.synced_by_user_id = u.id;
	if (u?.email) o.synced_by_email = u.email;
	return o;
}

/** owner_person_id for an operation: the recorder's person, or undefined to let the server default it. */
export function ownerPersonId(extra: Record<string, any> | null | undefined): string | undefined {
	return recorderFromExtra(extra)?.personId ?? undefined;
}

/** True when a Directus token exists to write with (false for an offline session or no session). */
export function hasServerSession(): boolean {
	return !authStore.state.offline && !!(authStore.state.accessToken || authStore.state.refreshToken);
}

export const OFFLINE_SESSION_UPLOAD_MESSAGE =
	'You are signed in offline, so nothing can be uploaded yet. Sign in again while connected (banner at the top) to upload.';

/**
 * The owner for an upload, resolved when the stamp has no person link (the lookup at sign-in can
 * fail, or the account was linked to a person later). `null` = the recorder has no person row, or
 * is the one uploading (the server default is then already right). THROWS if the lookup itself
 * fails: carrying on would hand ownership to whoever uploads, which is exactly what this stamp
 * exists to prevent, so the upload must wait instead.
 */
export async function resolveOwnerPersonId(extra: Record<string, any> | null | undefined): Promise<string | null> {
	const r = recorderFromExtra(extra);
	if (!r) return null;
	if (r.personId) return r.personId;
	if (r.userId === authStore.state.user?.id) return null;
	const res = await api.get('/items/people', { params: { filter: { user_id: { _eq: r.userId } }, fields: ['person_id'], limit: 1 } });
	return res.data?.data?.[0]?.person_id ?? null;
}
