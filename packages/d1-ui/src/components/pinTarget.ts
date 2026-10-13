import type { PinRef } from '../nav/sidebarModel';
import { pageTarget, recordTarget } from '../usage';

// What a page's Pin toggle pins (spec decision 5), or null when there is nothing to pin (the toggle
// is then not shown).

// An index page pins the saved view when one is open (its preset id, as the sidebar's view pins do),
// else the page itself. `path` is the route path, as pageTarget reads it.
export function pinTargetForIndex(path: string, bookmark: number | null): PinRef | null {
	if (bookmark !== null && Number.isInteger(bookmark) && bookmark >= 0) return { kind: 'view', target: String(bookmark) };
	const target = pageTarget(path);
	return target ? { kind: 'page', target } : null;
}

// A record page pins its record.
export function pinTargetForRecord(collection: string, id: string | null | undefined): PinRef | null {
	const target = recordTarget(collection, id);
	return target ? { kind: 'record', target } : null;
}
