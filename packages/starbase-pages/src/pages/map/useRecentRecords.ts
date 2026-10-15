import { ref } from 'vue';
import { loadRecordLabels, mapPath, splitRecordTarget, type HostApi } from '@d1/ui';
import { focusPlan } from './model/collections';

// The empty state's quick picks (spec section 8): the records this person used lately, to start a map from.
// The same GET /d1-usage the Home "Frequently used" panel reads (core/extensions/d1-usage), with the same
// labels (the kit's loadRecordLabels, read through the items API as the user, so a record
// that is gone or unreadable simply does not come back). Only records the map can open on are offered
// (not people), the newest first, at most MAX_PICKS. A usage that cannot be read is no list, not an error.

export const MAX_PICKS = 8;

export interface QuickPick {
  target: string;
  label: string;
  /** The app route of its own map. */
  to: string;
}

interface UsedRecord {
  target: string;
  collection: string;
  id: string;
  at: number;
}

const usedRecords = (body: any): UsedRecord[] =>
  (Array.isArray(body?.records) ? body.records : []).flatMap((r: any): UsedRecord[] => {
    const parts = typeof r?.target === 'string' ? splitRecordTarget(r.target) : null;
    if (!parts || !focusPlan(parts.collection)) return [];
    const at = Date.parse(r.last_at);
    return [{ target: r.target, ...parts, at: Number.isNaN(at) ? 0 : at }];
  });

/** The picks for the records this person used lately; [] when the usage cannot be read or holds nothing the map opens on. */
export async function loadRecentPicks(api: HostApi): Promise<QuickPick[]> {
  let used: UsedRecord[];
  try {
    used = usedRecords((await api.get('/d1-usage')).data).sort((a, b) => b.at - a.at); // stable: the endpoint's order breaks a tie
  } catch {
    return [];
  }
  const labels = new Map((await loadRecordLabels((path, config) => api.get(path, config), used)).map((e) => [e.target, e.label]));
  return used
    .filter((u) => labels.has(u.target))
    .slice(0, MAX_PICKS)
    .map((u) => ({ target: u.target, label: labels.get(u.target)!, to: mapPath(u.collection, u.id) }));
}

/** The picks as page state: `load()` once when the empty state first shows. */
export function useRecentRecords(api: HostApi) {
  const picks = ref<QuickPick[]>([]);
  let asked = false;
  async function load() {
    if (asked) return;
    asked = true;
    picks.value = await loadRecentPicks(api);
  }
  return { picks, load };
}
