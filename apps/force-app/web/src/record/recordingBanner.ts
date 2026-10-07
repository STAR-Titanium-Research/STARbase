// What the shell's cross-page banner shows for GET /record/status. A cut that has been stopped is
// 'finalizing' until its files are written, which can take a long time for a big capture; it is
// still the recorder's business, and the operator who navigated away should hear about it too.
export interface BannerRun {
	id: string;
	sampleName: string;
	samples: number;
	peakN: number;
	phase: 'recording' | 'finalizing';
	elapsedSec: number;
}

export function bannerRunFromStatus(data: any): BannerRun | null {
	const phase = data?.state;
	if (phase !== 'recording' && phase !== 'finalizing') return null;
	const p = data.peaks ?? {};
	return {
		id: data.id,
		sampleName: data.config?.sample_name || data.id,
		samples: Number(data.n_total ?? 0),
		// One headline number rather than three: the banner is a reassurance strip on another page,
		// not the Record page's readout.
		peakN: Math.max(Math.abs(p.Fx ?? 0), Math.abs(p.Fy ?? 0), Math.abs(p.Fz ?? 0)),
		phase,
		elapsedSec: Number(data.elapsed_sec ?? 0),
	};
}
