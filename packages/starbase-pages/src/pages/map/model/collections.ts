// The one table of the collections the Process map knows: which card kind each is drawn as, how a focus on it
// opens (spec D20), and the page that shows one record of it. Pure: no Vue, no I/O, no CSS.
//
// The map used to carry this as five maps (graph building, fans, connections, the record info, the rail's dots,
// the kind styles); they drifted apart, so there is one now and the rest read it.

import { recordRoute } from '@d1/ui';
import type { Kind } from './types';

/** How a focus opens (spec D20): a sample's family; an operation or test through its sample; a used-in fan; not at all. */
export type FocusPlan = 'sample' | 'step' | 'fan';

interface CollectionInfo {
  collection: string;
  kind: Kind;
  /** How a focus on a record of it opens. Absent: the map cannot open on it. */
  plan?: FocusPlan;
  /** A fan of it lists sample cards (the others list operations and tests, as collapsed containers). */
  sampleFan?: true;
  /** Drawn as a card of the process itself, never as a record inside a card's Inside tray. */
  card?: true;
}

/** Names the code reads by role; the table below is the only other place the strings are written. */
export const COLLECTION = {
  sample: 'physical_samples',
  operation: 'manufacturing_operations',
  test: 'test_sessions',
  stockLot: 'raw_stock_lots',
} as const;

const TABLE: readonly CollectionInfo[] = [
  { collection: COLLECTION.sample, kind: 'sample', plan: 'sample', card: true },
  { collection: COLLECTION.operation, kind: 'operation', plan: 'step', card: true },
  { collection: COLLECTION.test, kind: 'test', plan: 'step', card: true },
  { collection: COLLECTION.stockLot, kind: 'stock_lot', plan: 'fan' },
  { collection: 'equipment', kind: 'equipment', plan: 'fan' },
  { collection: 'tools', kind: 'tool', plan: 'fan' },
  { collection: 'insert_edges', kind: 'insert_edge', plan: 'fan' },
  { collection: 'fast_recipes', kind: 'recipe', plan: 'fan' },
  { collection: 'prep_recipes', kind: 'recipe', plan: 'fan' },
  { collection: 'materials', kind: 'material', plan: 'fan', sampleFan: true },
  { collection: 'projects', kind: 'project', plan: 'fan', sampleFan: true },
  { collection: 'campaigns', kind: 'campaign', plan: 'fan', sampleFan: true },
  { collection: 'directus_files', kind: 'data_file' },
  { collection: 'people', kind: 'person' },
  { collection: 'directus_users', kind: 'person' },
];

const BY_COLLECTION = new Map(TABLE.map((c) => [c.collection, c]));

/** Every collection in the table (for tests and for code that walks them). */
export const COLLECTIONS: readonly string[] = TABLE.map((c) => c.collection);

/** The kind a record of `collection` is drawn as, whatever it is; null when unknown. */
export const kindOf = (collection: string): Kind | null => BY_COLLECTION.get(collection)?.kind ?? null;

/** The kind of a record inside a card's Inside tray (a card of the process itself is not one); null when unknown. */
export const slotKindOf = (collection: string): Kind | null => {
  const c = BY_COLLECTION.get(collection);
  return c && !c.card ? c.kind : null;
};

/** The collection a kind is drawn from. Kinds shared by two collections (recipe, person) name the first; null for kinds with none. */
export const collectionOfKind = (kind: Kind): string | null => TABLE.find((c) => c.kind === kind)?.collection ?? null;

/** How a focus on `collection` opens; null when the map cannot open on it. */
export const focusPlan = (collection: string): FocusPlan | null => BY_COLLECTION.get(collection)?.plan ?? null;

/** Has a used-in fan: what ＋ on a record inside the map can open. */
export const hasFan = (collection: string): boolean => focusPlan(collection) === 'fan';

/** Its fan lists sample cards. */
export const isSampleFan = (collection: string): boolean => !!BY_COLLECTION.get(collection)?.sampleFan;

/** The kind a fan's root card is drawn as. */
export const fanKindOf = (collection: string): Kind => kindOf(collection) ?? 'data_file';

/** The page that shows one record (the Explorer page where there is one, else the Data Studio form). */
export const recordPath = (collection: string, id: string): string => recordRoute(collection, id);
