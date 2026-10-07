// Which FRM view (Figure / Lite / Full) to show for an operation, given the one the user asked for.
// Pure so the rule can be tested: it is applied every time a different file loads (#94).
export type FrmMode = 'figure' | 'lite' | 'full';

export interface ModeInputs {
	/** What the user last chose -- not whatever the previous op happened to be forced to. */
	preferred: FrmMode;
	octreeAvailable: boolean;
	liveAvailable: boolean;
	/** Points in the full-resolution map, or null when unknown. */
	fullResPoints: number | null;
	octreeThreshold: number;
	/** Connection fast enough to stream the cloud (see fastConnection()). */
	fast: boolean;
}

/**
 * Auto-route UP to Full for big maps that already have an octree (documented behaviour);
 * otherwise keep the user's preference, downgrading only as far as this op requires.
 */
export function pickMode(i: ModeInputs): FrmMode {
	if (i.octreeAvailable && i.fullResPoints && i.fullResPoints > i.octreeThreshold) return 'full';
	if (i.preferred === 'lite') return i.liveAvailable ? 'lite' : 'figure';
	if (i.preferred === 'full') return i.octreeAvailable ? 'full' : (i.liveAvailable && i.fast ? 'lite' : 'figure');
	return 'figure';
}
