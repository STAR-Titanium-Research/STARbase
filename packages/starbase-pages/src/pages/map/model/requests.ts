// What a request to the API is made of: chunking ids to the query budget, reading a list with the optional
// fields a role may refuse, and the answer's shape. Shared by the loaders (`loadFamily`, `loadFans`); no Vue.
//
// Filters go as a JSON string (`filter: JSON.stringify(...)`), like indexQuery and plotData do: a list of
// 150 ids as bracketed query keys would run into the 20-element array limit of the query parser.

import type { HostApi } from '@d1/ui';
import type { RelationDef } from './formSlots';

export type Json = Record<string, any>;

/** Most ids in one request, whatever the budget says. */
const CHUNK = 150;
/** Encoded query string of one request, in bytes: filter + fields + sort + limit (typical request-line limit 8 KB). */
const QUERY_BUDGET = 6000;

/**
 * Size of the query string a request would carry, serialised the way axios does it: an array is one
 * `key[]=value` pair per element, everything percent-encoded. Conservative on purpose (the brackets are
 * encoded too), so a request under the budget is under it for any client.
 */
export function encodedQuerySize(params: Record<string, unknown>): number {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) sp.append(`${key}[]`, String(v));
    else sp.append(key, String(value));
  }
  return sp.toString().length;
}

/**
 * Splits `ids` so that each chunk's request (`build(chunk)` = its params) stays within `budget` encoded
 * bytes (spec §7 step 2; typical servers refuse a request line over 8 KB). The cost of an id is
 * measured, not assumed, so ids of any length work. At most `CHUNK` ids per request; a single id that
 * alone exceeds the budget still goes out on its own.
 */
export function chunkByBudget(ids: string[], build: (chunk: string[]) => Record<string, unknown>, budget = QUERY_BUDGET): string[][] {
  const base = encodedQuerySize(build([]));
  const out: string[][] = [];
  let current: string[] = [];
  let size = base;
  for (const id of ids) {
    // The second copy of an id costs its quotes, its separator and its encoding: the marginal cost.
    const cost = encodedQuerySize(build([id, id])) - encodedQuerySize(build([id]));
    if (current.length && (size + cost > budget || current.length >= CHUNK)) {
      out.push(current);
      current = [];
      size = base;
    }
    current.push(id);
    size += cost;
  }
  if (current.length) out.push(current);
  return out;
}

export async function getList(api: HostApi, collection: string, params: Record<string, unknown>): Promise<{ rows: Json[]; total: number | null }> {
  const { data } = await api.get(`/items/${collection}`, { params });
  const rows = (data?.data ?? []) as Json[];
  const count = data?.meta?.filter_count;
  return { rows, total: count === undefined || count === null ? null : Number(count) };
}

/** Directus saying no to the request (a field the role may not read, a relation it cannot expand): 400, 403, 404. Not a 5xx or a network failure. */
export const isRefusal = (e: any): boolean => [400, 403, 404].includes(e?.response?.status);

// The recorded batch of an operation or test (spec D14). `batch_id` is only asked for when the runtime field defs of
// the collection list it (a database not yet migrated has no such column, and asking would refuse the whole read).
export const BATCH_FIELDS = ['batch_id.batch_id', 'batch_id.code'];
export const hasBatch = (defs: RelationDef[] | undefined): boolean => !!defs?.some((d) => d.field === 'batch_id' && !d.alias);

/** What a read adds to the fixed field list: the extra relations, and the batch when the defs list it. */
export interface Optional {
  extras: Extra[];
  batch: boolean;
}

/** Most encoded bytes the extra relation fields may add to a request (the rest of the budget is for the ids). */
const EXTRA_BUDGET = 2500;

/** A many-to-one relation of a form that the fixed field list does not read. */
export interface Extra {
  field: string;
  collection: string;
  key?: string;
}

/** What the fixed field lists already read, by root field. */
export const rootsOf = (fields: string[]): Set<string> => new Set(fields.map((f) => f.split('.')[0]));

/** The relations of a form the map has no named field for, as far as the byte budget allows (spec D6: every relation on the form). */
export function extrasOf(defs: RelationDef[] | undefined, roots: Set<string>): Extra[] {
  const out: Extra[] = [];
  for (const d of defs ?? []) {
    if (d.alias || roots.has(d.field) || out.some((e) => e.field === d.field)) continue;
    const next = [...out, { field: d.field, collection: d.collection, key: d.key }];
    if (encodedQuerySize({ fields: next.map((e) => `${e.field}.*`) }) > EXTRA_BUDGET) break;
    out.push(next[next.length - 1]);
  }
  return out;
}
const extraFields = (extras: Extra[]): string[] => extras.map((e) => `${e.field}.*`);

/** `fields` of a read with the optional ones: the fixed list, then the batch, then the extra relations. */
export function fieldsWith(fields: string[], { extras, batch }: Optional): string[] {
  return [...fields, ...(batch ? BATCH_FIELDS : []), ...extraFields(extras)];
}

/**
 * A list read that also asks for the batch and the extra relation fields. Directus refusing them is not the map's
 * problem: the read is made again with less. First with the extras and no batch, then with the batch and no extras
 * (each optional part can be the refused one), then with the fixed fields only. Only a refusal is retried; a server
 * or network error is thrown at once.
 */
export async function readList(api: HostApi, collection: string, params: Record<string, unknown>, optional: Optional): Promise<{ rows: Json[]; total: number | null }> {
  const fixed = params.fields as string[];
  const { extras, batch } = optional;
  const tiers: string[][] = [fieldsWith(fixed, optional)];
  if (batch && extras.length) tiers.push(fieldsWith(fixed, { extras, batch: false }), fieldsWith(fixed, { extras: [], batch }));
  if (batch || extras.length) tiers.push(fixed);
  for (const fields of tiers.slice(0, -1)) {
    try {
      return await getList(api, collection, { ...params, fields });
    } catch (e) {
      if (!isRefusal(e)) throw e;
    }
  }
  return getList(api, collection, { ...params, fields: tiers[tiers.length - 1] });
}
