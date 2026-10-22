// What Compare knows about its second file, as types only. A partner the person may not see is 'locked' (and never anything more): the address names it, the
// list the person can see does not hold it, and the page cannot tell a hidden file from one that is not there.
import type { FoundFile } from './inboxApi';
import type { MeasureShape } from './measure';

export type PartnerState =
	| { state: 'none' }
	| { state: 'loading' }
	| { state: 'locked' }
	| { state: 'ready'; file: FoundFile };

/** The one measure line, and the pane ('a' the open file, 'b' the partner) it was dragged in. */
export interface CompareMeasure {
	shape: MeasureShape;
	side: 'a' | 'b';
}
