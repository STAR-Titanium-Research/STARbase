// Keys of the small dialogs the edit mode opens (Duplicate ×N). Pure, so the rule is tested without a browser.

/**
 * Enter in a dialog confirms it only from a field: on a button it does what the button says (Cancel cancels), and the browser
 * presses it. `target` is the focused element the key went to.
 */
export function enterConfirms(target: unknown): boolean {
	const el = target as { closest?: (selector: string) => unknown } | null;
	return !(typeof el?.closest === 'function' && el.closest('button, [role="button"], a[href]'));
}
