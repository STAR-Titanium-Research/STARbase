// The data previews of a loaded family's operations (spec §6.6), read once when the family arrives (the
// way the index page reads its plot buttons after the rows arrive), so a hover card or the rail only
// looks the answer up: hovering costs no request. Until the answer comes, or when it is refused, a
// record just has no data block. A new family forgets them and drops answers still on their way.

import { shallowRef } from 'vue';
import type { HostApi } from '@d1/ui';
import { dataPreview, type DataPreview } from './model/dataPreview';
import type { Ref } from './model/types';

export function useDataPreviews(api: HostApi) {
  const previews = shallowRef<Record<string, DataPreview>>({});
  let epoch = 0;

  /** Forget the old family's and read these records'. Chunked by `dataPreview`; a failed read is `none`. */
  function load(refs: Ref[]): void {
    epoch += 1;
    previews.value = {};
    if (!refs.length) return;
    const mine = epoch;
    void dataPreview(api, refs)
      .then((answer) => {
        if (mine === epoch) previews.value = answer;
      })
      .catch(() => {
        /* no previews: the cards simply show no data block */
      });
  }

  return { previews, load };
}
