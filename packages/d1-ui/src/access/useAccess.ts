// The state of the "Who has access" dialog: the list, the parent's list (for the read-only inheritance block), a busy flag and
// the last message. Every write refetches the list and then calls `onChanged`, so the page behind the dialog can reload (the
// owner and the Edit button may have changed with a transfer). Host-neutral: the dialog hands in the host's api.
import { ref } from 'vue';
import { errorText } from '../format';
import { useRequestGate } from '../composables/useRequestGate';
import {
	addEntry, addTeamEntry, decideTeamMember, loadAccess, loadTeamMembers, removeEntry, removeTeamEntry, setRole, setTeamEntry, transfer, type AccessApi,
} from './accessApi';
import { blockedText, emailNote, isAccessCollection, showInherited, type AccessList, type TeamMembers } from './accessModel';

export interface AccessTarget {
	collection: string;
	id: string;
	/** The record this one inherits from (an operation or test: its sample). Read-only block, only when neither is Restricted. */
	parent?: { collection: string; id: string; label?: string } | null;
}

export function useAccess(api: AccessApi, target: () => AccessTarget, onChanged: () => void = () => {}) {
	const gate = useRequestGate();
	const list = ref<AccessList | null>(null);
	const parentList = ref<AccessList | null>(null);
	const loading = ref(false);
	const busy = ref(false);
	const error = ref('');
	const note = ref('');
	// Who gets access through each team grant, by team id; read when a manager expands a team's "N waiting" (see loadMembers).
	const teamMembers = ref<Record<string, TeamMembers>>({});

	async function load(quiet = false): Promise<boolean> {
		const token = gate.begin();
		const t = target();
		if (!quiet) {
			list.value = null;
			parentList.value = null;
			teamMembers.value = {};
			note.value = '';
		}
		error.value = '';
		loading.value = !quiet;
		const res = isAccessCollection(t.collection)
			? await loadAccess(api, t.collection, t.id)
			: ({ ok: false, message: 'That kind of record has no access list.' } as const);
		if (!gate.isCurrent(token)) return false;
		loading.value = false;
		if (!res.ok) {
			error.value = res.message;
			return false;
		}
		list.value = res.data;
		// The parent's list is a courtesy: when the caller cannot read it (404) the block is simply not drawn.
		let parent: AccessList | null = null;
		if (t.parent && !res.data.restricted && isAccessCollection(t.parent.collection)) {
			const p = await loadAccess(api, t.parent.collection, t.parent.id);
			if (!gate.isCurrent(token)) return false;
			parent = p.ok ? p.data : null;
		}
		parentList.value = showInherited(res.data, parent) ? parent : null;
		return true;
	}

	// One write at a time; the list is read again afterwards whether or not the write worked (a 404 on remove means it is gone already).
	async function write(run: () => Promise<{ ok: true; message?: string } | { ok: false; message: string }>): Promise<boolean> {
		if (busy.value) return false;
		busy.value = true;
		error.value = '';
		note.value = '';
		try {
			const res = await run();
			await load(true); // clears `error`, so the write's own message is set after it
			if (res.ok) {
				note.value = res.message ?? '';
				onChanged();
			} else {
				error.value = res.message;
			}
			return res.ok;
		} finally {
			busy.value = false;
		}
	}

	const add = (personId: string, role: string) =>
		write(async () => {
			const t = target();
			const res = await addEntry(api, t.collection, t.id, personId, role);
			return res.ok ? { ok: true as const, message: emailNote(res.data.email, 'added') ?? 'Added.' } : res;
		});

	const changeRole = (personId: string, role: string) =>
		write(async () => {
			const t = target();
			const res = await setRole(api, t.collection, t.id, personId, role);
			return res.ok ? { ok: true as const } : res;
		});

	const remove = (personId: string) =>
		write(async () => {
			const t = target();
			const res = await removeEntry(api, t.collection, t.id, personId);
			return res.ok ? { ok: true as const } : res;
		});

	/** To a person (an id or `{ person_id }`) or to a team (`{ team_id }`: the four ownable types). */
	const transferTo = (to: string | { person_id: string } | { team_id: string }) =>
		write(async () => {
			const t = target();
			const res = await transfer(api, t.collection, t.id, to);
			if (!res.ok) return res;
			// the change is made either way; a new owner who cannot read the record yet is told so, as on add
			const blocked = blockedText({ name: res.data.owner?.name ?? 'The new owner', blocked_by: res.data.blocked_by });
			return { ok: true as const, message: [emailNote(res.data.email, 'owner') ?? 'Ownership transferred.', blocked].filter(Boolean).join(' ') };
		});

	// ---- teams ----

	// A team's joiners. A failure shows its message and leaves what was there.
	async function loadMembers(teamId: string): Promise<boolean> {
		const t = target();
		const res = await loadTeamMembers(api, t.collection, t.id, teamId);
		if (!res.ok) {
			error.value = res.message;
			return false;
		}
		teamMembers.value = { ...teamMembers.value, [teamId]: res.data };
		return true;
	}

	const addTeam = (teamId: string, role: string) =>
		write(async () => {
			const t = target();
			const res = await addTeamEntry(api, t.collection, t.id, teamId, role);
			return res.ok ? { ok: true as const, message: emailNote(res.data.email, 'team') ?? 'Added.' } : res;
		});

	const changeTeam = (teamId: string, patch: { role?: string; trust_new_members?: boolean }) =>
		write(async () => {
			const t = target();
			const res = await setTeamEntry(api, t.collection, t.id, teamId, patch);
			return res.ok ? { ok: true as const } : res;
		});

	const removeTeam = (teamId: string) =>
		write(async () => {
			const t = target();
			const res = await removeTeamEntry(api, t.collection, t.id, teamId);
			if (res.ok) {
				const { [teamId]: _gone, ...rest } = teamMembers.value;
				teamMembers.value = rest;
			}
			return res.ok ? { ok: true as const } : res;
		});

	// Approve or decline one waiting joiner. The list's counts and that team's people are read again either way.
	async function decide(teamId: string, personId: string, decision: 'approve' | 'decline'): Promise<boolean> {
		const ok = await write(async () => {
			const t = target();
			const res = await decideTeamMember(api, t.collection, t.id, teamId, personId, decision);
			if (!res.ok) return res;
			return { ok: true as const, message: decision === 'approve' ? 'Approved.' : 'Declined.' };
		});
		if (teamMembers.value[teamId]) {
			// keep the write's own message: loadMembers only speaks on failure
			await loadMembers(teamId);
		}
		return ok;
	}

	// The Restrict switch (hidden until A1b): restricting is a PATCH of the record, owner only (the guard decides).
	const setRestricted = (value: boolean) =>
		write(async () => {
			const t = target();
			try {
				await api.patch(`/items/${t.collection}/${encodeURIComponent(t.id)}`, { restricted: value });
				return { ok: true as const };
			} catch (e) {
				return { ok: false as const, message: errorText(e, 'Could not change it.') };
			}
		});

	return {
		list, parentList, loading, busy, error, note, teamMembers, load, add, changeRole, remove, transferTo, setRestricted,
		addTeam, changeTeam, removeTeam, loadMembers, decide, cancel: () => gate.cancel(),
	};
}
