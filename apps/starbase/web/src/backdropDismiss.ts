// The phone sheet's backdrop closes it only for a real tap on the backdrop: the press must have STARTED
// on the backdrop (not inside the sheet) and the click must END on it. A click fires on the common
// ancestor of where the press began and ended, so pressing inside the sheet and releasing outside it
// would otherwise dismiss the menu.
export function backdropDismiss(startedOnBackdrop: boolean, endedOnBackdrop: boolean): boolean {
	return startedOnBackdrop && endedOnBackdrop;
}
