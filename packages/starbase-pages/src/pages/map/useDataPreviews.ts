// The data previews of a loaded family's operations (spec §6.6), read when the family arrives (the way the
// index page reads its plot buttons after the rows arrive), so a hover card or the rail only looks the
// answer up: hovering costs no request. Until the answer comes, or when it is refused, a record just has no
// data block. An expand that adds operations asks for those only and keeps the answers already held; a new
// focus `reset`s them and drops answers still on their way.

import { shallowRef } from 'vue';
import type { HostApi } from '@d1/ui';
import { conformThumbs, dataPreview, type DataPreview } from './model/dataPreview';
import type { Ref } from './model/types';

export function useDataPreviews(api: HostApi) {
  const previews = shallowRef<Record<string, DataPreview>>({});
  /** Ids already read (or being read) for this focus. */
  const asked = new Set<string>();
  let epoch = 0;

  /** A new focus: forget the old answers, and let those still on their way be dropped. */
  function reset(): void {
    epoch += 1;
    asked.clear();
    previews.value = {};
  }

  /** Read the previews of the records not asked for yet and add them to the held ones. Chunked by `dataPreview`; a failed read is `none`. */
  function load(refs: Ref[]): void {
    const fresh = refs.filter((r, i) => !asked.has(r.id) && refs.findIndex((x) => x.id === r.id) === i);
    if (!fresh.length) return;
    for (const r of fresh) asked.add(r.id);
    const mine = epoch;
    void dataPreview(api, fresh)
      .then((answer) => {
        if (mine !== epoch) return;
        previews.value = { ...previews.value, ...answer };
        // A Conform run's trace comes after the previews, so a slow CSV never holds back the rest.
        return conformThumbs(api, answer).then((thumbs) => {
          if (mine !== epoch) return;
          const next = { ...previews.value };
          for (const [id, thumb] of Object.entries(thumbs)) if (next[id]) next[id] = { ...next[id], thumb };
          previews.value = next;
        });
      })
      .catch(() => {
        /* no previews: the cards simply show no data block */
      });
  }

  return { previews, load, reset };
}
