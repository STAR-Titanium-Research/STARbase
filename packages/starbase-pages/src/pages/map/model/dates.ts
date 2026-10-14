// Dates of the Process map's steps, as the cards and the rail say them. Pure: no Vue, no I/O.

import { formatDate } from '@d1/ui';

const dateOf = (d: string | null): number => (d ? Date.parse(d) : NaN);

/** One date, or "first – last" when the rows of a batch or a stack differ; empty when none has a date. */
export function dateText(dates: (string | null)[]): string {
  const valid = dates.filter((d): d is string => !!d && !Number.isNaN(dateOf(d))).sort((a, b) => dateOf(a) - dateOf(b));
  if (!valid.length) return '';
  const first = formatDate(valid[0]);
  const last = formatDate(valid[valid.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}
