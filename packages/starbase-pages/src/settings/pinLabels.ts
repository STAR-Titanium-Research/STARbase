import { splitRecordTarget, type PinRef } from '@d1/ui';

// What to call a pin that no longer resolves (a page, view or record the person cannot see any more).
// There is no name to show, so say what kind it was and which one: "Page /home/labels", "Saved view 12",
// "Record samples 3f2a9c…".
export function unavailableLabel(pin: PinRef): string {
	if (pin.kind === 'page') return `Page ${pin.target}`;
	if (pin.kind === 'view') return `Saved view ${pin.target}`;
	const parts = splitRecordTarget(pin.target);
	if (!parts) return `Record ${pin.target}`;
	const id = parts.id.length > 8 ? `${parts.id.slice(0, 8)}…` : parts.id;
	return `Record ${parts.collection} ${id}`;
}
