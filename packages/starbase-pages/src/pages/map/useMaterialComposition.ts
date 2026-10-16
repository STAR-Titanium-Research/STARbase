// The composition of a material (its alloying elements with their nominal wt%), read when its hover card
// opens or it is selected, never for every card up front: one request per material, then held. A refused
// read (a role that cannot see the table) or a material with no rows is `null`: the card shows just the name.
// Through `HostApi` only, like the rest of the map.

import { shallowRef } from 'vue';
import type { ElementRow, HostApi } from '@d1/ui';

export function useMaterialComposition(api: HostApi) {
  /** The rows of each material read so far; `null` = none recorded or not readable. Absent while the read is on its way. */
  const compositions = shallowRef<Record<string, ElementRow[] | null>>({});
  /** Ids already read (or being read). */
  const asked = new Set<string>();

  /** Read `materialId`'s elements unless that has been done already. */
  function load(materialId: string): void {
    if (asked.has(materialId)) return;
    asked.add(materialId);
    void api
      .get('/items/material_alloying_elements', {
        params: { filter: { material_id: { _eq: materialId } }, fields: ['symbol', 'weight_percent'], limit: -1 },
      })
      .then((res) => {
        const rows = res.data?.data;
        return Array.isArray(rows) && rows.length ? (rows as ElementRow[]) : null;
      })
      .catch(() => null)
      .then((rows) => {
        compositions.value = { ...compositions.value, [materialId]: rows };
      });
  }

  return { compositions, load };
}
