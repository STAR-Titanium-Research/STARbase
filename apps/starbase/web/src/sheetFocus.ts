// Where focus goes when the phone sheet closes. Back to the Menu button that opened it, as long as the
// phone layout (and so that button) is still there and the close did not hand focus to something else
// (the finder opened from the sheet).
export function returnFocusToMenu(opts: { narrow: boolean; handedOff: boolean }): boolean {
	return opts.narrow && !opts.handedOff;
}
