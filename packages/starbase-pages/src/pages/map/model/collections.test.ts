import { describe, expect, it } from 'vitest';
import { recordRoute } from '@d1/ui';
import { COLLECTION, COLLECTIONS, collectionOfKind, fanKindOf, focusPlan, hasFan, isSampleFan, kindOf, recordPath, slotKindOf } from './collections';
import { KINDS } from '../nodes/kinds';

describe('collections table', () => {
  it('maps every collection to a kind that has a style, and back', () => {
    for (const c of COLLECTIONS) {
      const kind = kindOf(c);
      expect(kind, c).not.toBeNull();
      expect(KINDS[kind!], c).toBeDefined();
      // Two collections can share a kind (recipes, people): the way back names a collection of that kind.
      expect(kindOf(collectionOfKind(kind!)!), c).toBe(kind);
    }
  });

  it('gives the process cards their own collections, one way round and the other', () => {
    expect(collectionOfKind('sample')).toBe('physical_samples');
    expect(collectionOfKind('operation')).toBe('manufacturing_operations');
    expect(collectionOfKind('test')).toBe('test_sessions');
    expect(collectionOfKind('stock_lot')).toBe('raw_stock_lots');
    for (const c of Object.values(COLLECTION)) expect(collectionOfKind(kindOf(c)!)).toBe(c);
  });

  it('knows nothing of a collection outside the table, and of kinds with no collection', () => {
    expect(kindOf('widgets')).toBeNull();
    expect(slotKindOf('widgets')).toBeNull();
    expect(focusPlan('widgets')).toBeNull();
    expect(collectionOfKind('junction')).toBeNull();
    expect(collectionOfKind('powder_batch')).toBeNull();
    expect(fanKindOf('widgets')).toBe('data_file');
  });

  it('draws a card of the process as a slot record of no kind', () => {
    for (const c of [COLLECTION.sample, COLLECTION.operation, COLLECTION.test]) {
      expect(kindOf(c)).not.toBeNull();
      expect(slotKindOf(c)).toBeNull();
    }
    expect(slotKindOf('equipment')).toBe('equipment');
    expect(slotKindOf('raw_stock_lots')).toBe('stock_lot');
  });

  it('opens a fan only on collections that have one, and lists samples for three of them', () => {
    for (const c of COLLECTIONS) expect(hasFan(c), c).toBe(focusPlan(c) === 'fan');
    expect(COLLECTIONS.filter(isSampleFan).sort()).toEqual(['campaigns', 'materials', 'projects']);
    expect(fanKindOf('tools')).toBe('tool');
  });

  it('sends a record to the page recordRoute names', () => {
    for (const c of COLLECTIONS) expect(recordPath(c, 'a b')).toBe(recordRoute(c, 'a b'));
    expect(recordPath('physical_samples', 'x')).toBe('/home/samples/x');
  });
});
