// Reads the state of the gear that templates and draft cards name, once each, as the signed-in person (Directus permissions decide what is
// readable): the machine, the tool and the cutting edge. A read that fails leaves the gear unknown and nothing is warned: a warning is a help,
// never a block. Reactive: the checks and the palette read `problem`.

import { reactive } from 'vue';
import type { HostApi } from '@d1/ui';
import { chunkByBudget } from '../model/requests';
import { GEAR_READS, gearIn, gearKey, gearProblem, gearToRead, type GearField } from './gearStatus';

type Row = Record<string, unknown>;

export function useGearStatus(api: HostApi) {
	/** '' = fine, otherwise the warning; a key that is absent has not been read (or could not be). */
	const state = reactive(new Map<string, string>());
	const asked = new Set<string>();
	/** Gear whose read failed: not asked again until `forget` (the draft changed), so a rail keystroke does not repeat a read that cannot work. */
	const failed = new Set<string>();

	/** Reads the gear the given values name (any number of records' values), for the ones not read yet. */
	async function ensure(valueSets: Iterable<Record<string, unknown>>): Promise<void> {
		const want = [...valueSets].flatMap((v) => gearIn(v));
		const todo = gearToRead(want, (k) => asked.has(k));
		await Promise.all(
			(Object.keys(todo) as GearField[]).map(async (field) => {
				const ids = todo[field];
				if (!ids.length) return;
				for (const id of ids) asked.add(gearKey(field, id));
				const read = GEAR_READS[field];
				try {
					const build = (chunk: string[]) => ({ filter: JSON.stringify({ [read.key]: { _in: chunk } }), fields: read.fields, limit: -1 });
					const pages = await Promise.all(chunkByBudget(ids, build).map((chunk) => api.get(`/items/${read.collection}`, { params: build(chunk) })));
					for (const row of pages.flatMap((p) => (p.data?.data ?? []) as Row[])) state.set(gearKey(field, String(row[read.key])), gearProblem(field, row) ?? '');
				} catch {
					// Not readable (a role without access to it) or the server failed: unknown, and left alone until `forget`.
					for (const id of ids) failed.add(gearKey(field, id));
				}
			}),
		);
	}

	/** Lets the gear whose read failed be asked about again (a different draft was opened). */
	function forget(): void {
		for (const k of failed) asked.delete(k);
		failed.clear();
	}

	/** The warning for one piece of gear, or undefined when it is fine or not known. */
	const problem = (field: GearField, id: string): string | undefined => state.get(gearKey(field, id)) || undefined;

	return { ensure, forget, problem, state };
}

export type GearStatus = ReturnType<typeof useGearStatus>;
