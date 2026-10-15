// The Show chips (spec D14, D25): which kinds the person hides, what is remembered of it, and what the chips do to
// the nodes drawn. Pure apart from the localStorage guard; no Vue.

import { KINDS } from '../nodes/kinds';
import { slotKindOf } from './collections';
import type { ContainerNode, MapNode, Ref } from './types';

/** localStorage key of the Show chips (spec D25). */
export const SHOW_KEY = 'd1.map.show.v1';
/** The Show chip that hides key settings: not a kind, kept in the same set. */
export const SETTINGS_CHIP = 'settings';
/** Cards that are only ever drawn beside what they feed; a Show chip each. */
const SOURCE_KINDS = ['stock_lot', 'powder_batch', 'material'];
/** What a Show chip may hide: never the samples, operations, tests or lineage the wires run through. */
const STRUCTURAL = new Set(['sample', 'operation', 'test', 'junction']);
export const HIDEABLE: ReadonlySet<string> = new Set([...Object.keys(KINDS).filter((k) => !STRUCTURAL.has(k)), SETTINGS_CHIP]);

export interface Remembered {
  hidden: string[];
  probable: boolean;
  /** The "Stack passes" chip. */
  stack: boolean;
}

/** localStorage can be missing (node), blocked or full: every access is guarded and falls back to the defaults. */
export function readRemembered(): Remembered {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOW_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      return {
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((k: unknown): k is string => typeof k === 'string' && HIDEABLE.has(k)) : [],
        probable: parsed.probable !== false,
        stack: parsed.stack !== false,
      };
    }
  } catch {
    /* no storage: defaults */
  }
  return { hidden: [], probable: true, stack: true };
}

export function writeRemembered(r: Remembered): void {
  try {
    localStorage.setItem(SHOW_KEY, JSON.stringify(r));
  } catch {
    /* not remembered; the chips still work for this visit */
  }
}

/** The shown nodes with the Show chips applied to their Inside slots and key settings, and other projects tagged (spec D13). */
export function drawnNodes(nodes: MapNode[], hide: ReadonlySet<string>, home: string | null, projectRefs: ReadonlyMap<string, Ref>): MapNode[] {
  return nodes.map((n) => {
    // Spec D13: a record of another project says so on its meta line.
    if (n.type === 'record' && home && n.projectId && n.projectId !== home) {
      const code = projectRefs.get(n.projectId)?.code;
      return { ...n, meta: [n.meta, code ? `project ${code}` : 'other project'].filter(Boolean).join(' · ') };
    }
    if (n.type !== 'container') return n;
    const slots = n.slots.filter((s) => {
      const refs = s.ref ? [s.ref] : (s.values ?? []);
      const kind = refs[0] ? slotKindOf(refs[0].collection) : null;
      return !(kind && hide.has(kind));
    });
    const settings = hide.has(SETTINGS_CHIP) ? [] : n.settings;
    return slots.length === n.slots.length && settings === n.settings ? n : ({ ...n, slots, settings } satisfies ContainerNode);
  });
}

/** The kinds a Show chip can hide here: source cards and Inside slot kinds present, and the settings chip. */
export function presentKinds(nodes: readonly MapNode[]): string[] {
  const kinds = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'record' && SOURCE_KINDS.includes(n.kind)) kinds.add(n.kind);
    if (n.type === 'container') {
      for (const s of n.slots) {
        const r = s.ref ?? s.values?.[0];
        const k = r ? slotKindOf(r.collection) : null;
        if (k) kinds.add(k);
      }
      if (n.settings.length) kinds.add(SETTINGS_CHIP);
    }
  }
  return [...kinds];
}
