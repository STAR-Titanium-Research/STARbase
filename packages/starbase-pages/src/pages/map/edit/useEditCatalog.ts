// The reference data edit mode reads through the host's API (as the signed-in user, so Directus permissions decide what is
// offered): the methods and test types of the add search, the field definitions of the three collections a draft holds, the
// existing records of a draft (version and fields, for stale checks and for building from them), the samples picked from
// the index, and the codes of the materials the sample codes are made of. Everything is read once and kept; a read that
// fails leaves what is known and the menu shows less, nothing is blocked.

import { computed, reactive, ref, shallowRef } from 'vue';
import type { FieldDef as DirectusField, HostApi } from '@d1/ui';
import type { SampleRec } from '../model/types';
import { chunkByBudget } from '../model/requests';
import { SAMPLE_FIELDS, mapSample } from '../model/rows';
import type { CheckCollection, CheckCtx, FieldDef, LoadedRecord } from './checks';
import { collectionOf, recordKey } from './checks';
import { useGearStatus } from './useGearStatus';
import { KEY_FIELD, METHOD_FIELDS, checkFieldsOf, existingIds, loadedRecordOf, methodsOf, testTypesOf, type MethodEntry, type TestTypeEntry } from './catalog';

type Row = Record<string, any>;

/** The key of a relation read as an object (`material_id.alloy_code` expands it), or as the key itself. */
const keyOf = (v: unknown, key: string): unknown => (v && typeof v === 'object' ? ((v as Row)[key] ?? null) : (v ?? null));

const COLLECTIONS: CheckCollection[] = ['physical_samples', 'manufacturing_operations', 'test_sessions'];

export function useEditCatalog(api: HostApi, fieldsFor: (collection: string) => Promise<DirectusField[]>) {
	/** The state of the machines, tools and edges that templates and new cards name (retired, used up): the checks warn about them. */
	const gear = useGearStatus(api);
	const methods = shallowRef<MethodEntry[]>([]);
	const testTypes = shallowRef<TestTypeEntry[]>([]);
	/** The raw field definitions of each collection (the generated form reads them). */
	const rawFields = shallowRef<Partial<Record<CheckCollection, DirectusField[]>>>({});
	const checkFields = computed(() => {
		const out: Partial<Record<CheckCollection, FieldDef[]>> = {};
		for (const c of COLLECTIONS) if (rawFields.value[c]) out[c] = checkFieldsOf(rawFields.value[c]!);
		return out;
	});
	const loading = ref(false);
	/** Existing records, read, by `<collection>:<id>`; null = asked for and not readable. Reactive: the checks read it. */
	const records = reactive(new Map<string, LoadedRecord | null>());
	/** Existing samples of the draft that are not part of the loaded history (picked from the index), as the map draws them. */
	const samples = reactive(new Map<string, SampleRec>());
	/** The alloy code and the name of a material, by id. */
	const materials = reactive(new Map<string, { alloy: string | null; name: string | null }>());

	let started: Promise<void> | null = null;
	/** Reads the menus' data and the field definitions, once. */
	function ensure(): Promise<void> {
		if (started) return started;
		loading.value = true;
		const defs = async () => {
			const out: Partial<Record<CheckCollection, DirectusField[]>> = {};
			await Promise.all(
				COLLECTIONS.map(async (c) => {
					try {
						out[c] = await fieldsFor(c);
					} catch {
						/* no definitions: nothing is required, the test types are missing */
					}
				}),
			);
			rawFields.value = out;
			testTypes.value = testTypesOf(out.test_sessions ?? []);
		};
		const meths = async () => {
			try {
				const res = await api.get('/items/manufacturing_methods', { params: { fields: METHOD_FIELDS, sort: 'method_name', limit: -1 } });
				methods.value = methodsOf(res.data?.data ?? []);
			} catch {
				/* the menu offers no methods */
			}
		};
		started = Promise.all([defs(), meths()]).then(() => void (loading.value = false));
		return started;
	}

	/** Rows of a collection by key, in chunks that keep the query short. */
	async function readRows(collection: CheckCollection, ids: string[], fields: string[]): Promise<Row[]> {
		const key = KEY_FIELD[collection];
		const build = (chunk: string[]) => ({ filter: JSON.stringify({ [key]: { _in: chunk } }), fields, limit: -1 });
		const pages = await Promise.all(chunkByBudget(ids, build).map((chunk) => api.get(`/items/${collection}`, { params: build(chunk) })));
		return pages.flatMap((p) => (p.data?.data ?? []) as Row[]);
	}

	/** Records being read (with the read that has them), and records whose read failed: neither is asked for again on every change of the draft. */
	const readingRecords = new Map<string, Promise<void>>();
	const failedRecords = new Set<string>();
	const forgetFailed = (): void => {
		failedRecords.clear();
		gear.forget();
	};

	/**
	 * Reads the existing records of a draft (version and fields): what its checks and its stale warnings are made of. A record that is being
	 * read is waited for, not skipped (a caller that needs the answer, like a delete that needs the version, gets it); `retry` asks again for
	 * one whose read failed, which the draft's own reads leave alone.
	 */
	async function loadRecords(want: Record<CheckCollection, string[]>, opts: { retry?: boolean } = {}): Promise<void> {
		await Promise.all(
			COLLECTIONS.map(async (c) => {
				if (opts.retry) for (const id of want[c]) failedRecords.delete(recordKey(c, id));
				const waiting = want[c].map((id) => readingRecords.get(recordKey(c, id))).filter((r): r is Promise<void> => !!r);
				const ids = want[c].filter((id) => ![records.has(recordKey(c, id)), readingRecords.has(recordKey(c, id)), failedRecords.has(recordKey(c, id))].some(Boolean));
				if (ids.length) {
					const read = (async () => {
						try {
							const rows = await readRows(c, ids, ['*']);
							const seen = new Set<string>();
							for (const row of rows) {
								const id = String(row[KEY_FIELD[c]]);
								seen.add(id);
								records.set(recordKey(c, id), loadedRecordOf(row));
							}
							// Asked for and not answered: gone, or not readable by this person.
							for (const id of ids) if (!seen.has(id)) records.set(recordKey(c, id), null);
						} catch {
							/* unknown: the server's check tells */
							for (const id of ids) failedRecords.add(recordKey(c, id));
						} finally {
							for (const id of ids) readingRecords.delete(recordKey(c, id));
						}
					})();
					for (const id of ids) readingRecords.set(recordKey(c, id), read);
					waiting.push(read);
				}
				await Promise.all(waiting);
			}),
		);
	}

	type SampleRead = Map<string, { sample: SampleRec; version: number; values: Row }>;
	/** Samples being read, by id, with the read that has them: a second ask for one waits for that read instead of making its own. */
	const readingSamples = new Map<string, Promise<SampleRead>>();

	/** Reads picked samples: their card data (for the map) and their version (for the draft). Returns what was read, by id. */
	async function loadSamples(ids: string[]): Promise<SampleRead> {
		const out: SampleRead = new Map();
		if (!ids.length) return out;
		const fresh = [...new Set(ids)].filter((id) => !readingSamples.has(id));
		if (fresh.length) {
			const read = readSamples(fresh);
			const done = () => void fresh.forEach((id) => readingSamples.delete(id));
			read.then(done, done);
			for (const id of fresh) readingSamples.set(id, read);
		}
		for (const read of new Set(ids.map((id) => readingSamples.get(id)).filter((r): r is Promise<SampleRead> => !!r))) {
			for (const [id, got] of await read) if (ids.includes(id)) out.set(id, got);
		}
		return out;
	}
	async function readSamples(ids: string[]): Promise<SampleRead> {
		const out: SampleRead = new Map();
		// The card's fields (with the material and project expanded) and the whole record: the form edits the record, the card draws it.
		const rows = await readRows('physical_samples', ids, ['*', ...SAMPLE_FIELDS, 'version']);
		for (const row of rows) {
			const sample = mapSample(row);
			samples.set(sample.id, sample);
			const version = Number(row.version);
			if (Number.isFinite(version)) {
				// The expanded relations back to their ids: what a form and a new sample's inheritance work with.
				const values: Row = { ...row, material_id: keyOf(row.material_id, 'material_id'), project_id: keyOf(row.project_id, 'project_id') };
				out.set(sample.id, { sample, version, values });
				records.set(recordKey('physical_samples', sample.id), { version, values });
			}
		}
		return out;
	}

	/** The samples whose code or nickname contains `q`, for the menu's "Existing sample…" search (as the Finder asks, 5-8 rows). */
	async function searchSamples(q: string): Promise<{ id: string; code: string; detail: string }[]> {
		const text = q.trim();
		if (text.length < 2) return [];
		const filter = { _or: [{ sample_code: { _icontains: text } }, { nickname: { _icontains: text } }] };
		const res = await api.get('/items/physical_samples', { params: { fields: ['sample_id', 'sample_code', 'nickname', 'form'], filter: JSON.stringify(filter), sort: 'sample_code', limit: 8 } });
		return ((res.data?.data ?? []) as Row[]).map((r) => ({ id: String(r.sample_id), code: String(r.sample_code ?? 'Sample'), detail: [r.nickname, r.form].filter(Boolean).join(' · ') }));
	}

	const missingMaterials = new Set<string>();
	/** Asks for the alloy code of these materials, once each (the sample code is made of it). */
	async function ensureMaterials(ids: Iterable<string>): Promise<void> {
		const want = [...new Set(ids)].filter((id) => id && !materials.has(id) && !missingMaterials.has(id));
		if (!want.length) return;
		for (const id of want) missingMaterials.add(id);
		try {
			const build = (chunk: string[]) => ({ filter: JSON.stringify({ material_id: { _in: chunk } }), fields: ['material_id', 'alloy_code', 'common_name'], limit: -1 });
			const pages = await Promise.all(chunkByBudget(want, build).map((chunk) => api.get('/items/materials', { params: build(chunk) })));
			for (const row of pages.flatMap((p) => (p.data?.data ?? []) as Row[])) {
				materials.set(String(row.material_id), { alloy: row.alloy_code ? String(row.alloy_code) : null, name: row.common_name ? String(row.common_name) : null });
			}
		} catch {
			/* the code stays unmade: Checks says so */
		}
	}

	const methodById = computed(() => new Map(methods.value.map((m) => [m.id, m])));
	const methodCode = (id: string): string | null => methodById.value.get(id)?.code || null;
	const alloyCode = (id: string): string | null => materials.get(id)?.alloy ?? null;

	/** The part of the checks' and the sample codes' context this knows; the page adds the draft-specific `record`. */
	function ctx(): CheckCtx {
		return {
			fields: checkFields.value,
			records: Object.fromEntries(records),
			alloyCode,
			methodCode,
			gear: gear.problem,
			record: (item) => (item.existing ? records.get(recordKey(collectionOf(item), item.existing.id))?.values : undefined),
		};
	}

	return {
		gear, methods, testTypes, rawFields, checkFields, loading, records, samples, materials, methodById,
		ensure, loadRecords, loadSamples, forgetFailed, searchSamples, ensureMaterials, methodCode, alloyCode, ctx,
		existingIds,
	};
}

export type EditCatalog = ReturnType<typeof useEditCatalog>;
