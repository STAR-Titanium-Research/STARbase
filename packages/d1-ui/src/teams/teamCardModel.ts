// The words and attributes of the members card that are not drawing: what the trigger tells assistive technology, and the one line the card's
// live region says as it loads. Pure, so the slot props of TeamCard are tested without a DOM.

export interface TriggerAttrs {
	'aria-expanded': boolean;
	/** Only while the card is open: the popover is not in the page before that, and an id that points nowhere is worse than none. */
	'aria-controls'?: string;
}

/**
 * What a trigger bound to a TeamCard carries (TeamCard hands it out as the slot prop `triggerAttrs`). The card is a disclosure, not a dialog: it
 * opens on hover and focus without taking focus, so the trigger says expanded or not and what it controls, and does not promise a popup with focus handling.
 */
export const triggerAttrs = (open: boolean, popId: string): TriggerAttrs => ({
	'aria-expanded': open,
	...(open ? { 'aria-controls': popId } : {}),
});

/** The live region's line: the failure, the loading note, or the team's name and size once it is there. */
export function cardStatus(team: { name: string } | null, memberCount: number, failed: string): string {
	if (failed) return failed;
	if (!team) return 'Loading the team…';
	return `${team.name}, ${memberCount} member${memberCount === 1 ? '' : 's'}`;
}
