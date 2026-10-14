// What opening the Process map on a record loads (spec D20), and the relation defs of the two forms it reads
// first. Through `HostApi` only; no Vue.

import { isNotVisible, type HostApi } from '@d1/ui';
import { FALLBACK_RELATIONS } from './formSlots';
import { fanData, fanPage } from './fans';
import { COLLECTION, fanKindOf, type FocusPlan } from './collections';
import { loadFamily, loadRelationDefs, type FormDefs } from './loadFamily';
import { loadRecordRef, loadStepRow, loadUsedIn, sampleOfRow } from './loadFans';
import type { ProcessData } from './types';

/** `runtime`: both forms were read from the server (not the fallback lists), so the loader may ask for their relations too. */
export type DefsByKind = FormDefs & { runtime: boolean };
const defsCache = new WeakMap<HostApi, Promise<DefsByKind>>();

/** The relations of the two forms, cached per api. A refused or failed read is not fatal: the known relations of each form stand in (spec §7 step 5). */
export function loadDefs(api: HostApi): Promise<DefsByKind> {
  let cached = defsCache.get(api);
  if (!cached) {
    const read = (collection: string, kind: 'operation' | 'test') =>
      loadRelationDefs(api, collection)
        .catch(() => null)
        .then((defs) => ({ defs: defs ?? FALLBACK_RELATIONS[kind], runtime: !!defs }));
    cached = Promise.all([read(COLLECTION.operation, 'operation'), read(COLLECTION.test, 'test')]).then(([operation, test]) => ({
      operation: operation.defs,
      test: test.defs,
      runtime: operation.runtime && test.runtime,
    }));
    defsCache.set(api, cached);
  }
  return cached;
}

/**
 * A sample's family and the relations of the two forms. The forms are read first (cached per api) so the loader can ask
 * for every relation on them too (spec D6); when they were refused it reads what it always did.
 */
export async function loadFamilyAndDefs(api: HostApi, sampleId: string): Promise<{ family: ProcessData; defs: DefsByKind }> {
  const relationDefs = await loadDefs(api);
  const family = await loadFamily(api, sampleId, ...(relationDefs.runtime ? [{ operation: relationDefs.operation, test: relationDefs.test }] : []));
  return { family, defs: relationDefs };
}

/** A focused operation or test that has no sample to open the family of. */
export class NoSample extends Error {}

/** What opening on a record loads (spec D20). */
export async function loadFocus(api: HostApi, f: { collection: string; id: string }, plan: FocusPlan): Promise<{ data: ProcessData; defs: DefsByKind }> {
  if (plan === 'sample') {
    const { family, defs: relationDefs } = await loadFamilyAndDefs(api, f.id);
    return { data: family, defs: relationDefs };
  }
  if (plan === 'step') {
    // The family of the step's sample, with the step's own container focused.
    const row = await loadStepRow(api, f);
    const kind = f.collection === COLLECTION.test ? 'test' : 'operation';
    const sampleId = sampleOfRow(row);
    if (!sampleId) throw new NoSample(`This ${kind} has no sample, so there is no Process map to show.`);
    // The step itself was read, so a refused trace is its sample that is hidden, not the step ("this operation
    // does not exist" would be wrong: its own page opens). A role can read a step without its sample.
    const { family, defs: relationDefs } = await loadFamilyAndDefs(api, sampleId).catch((e: unknown) => {
      throw isNotVisible(e) ? new NoSample(`You can read this ${kind}, but not the sample it belongs to, so there is no Process map to show.`) : e;
    });
    const inFamily = kind === 'test' ? family.tests.some((t) => t.id === row.id) : family.operations.some((o) => o.id === row.id);
    if (!inFamily) return { data: family, defs: relationDefs };
    return { data: { ...family, focus: { collection: f.collection, id: row.id, code: row.code, kind } }, defs: relationDefs };
  }
  const [record, used, relationDefs] = await Promise.all([loadRecordRef(api, f), loadUsedIn(api, f, 1), loadDefs(api)]);
  return { data: fanData({ ...record, kind: fanKindOf(f.collection) }, fanPage(f.collection, used, 1)), defs: relationDefs };
}
