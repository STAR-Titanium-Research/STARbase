// What makes one run plotter different from another. FastDashboard is a run plotter: samples -> runs, the run's
// figures, and tiles of traces. Everything specific to FAST (the sintering list query, the fast_run_data
// loader, the peak figures, the empty-state wording) used to be hard-wired in it; it now comes from a profile,
// and `fastProfile` reproduces the old behaviour exactly. The Conform plotter is a second profile.
//
// The optional members at the bottom exist only for profiles that have them (Conform): FAST leaves them out and
// the dashboard shows none of the windows, upload or clock-time features.
import type { AxiosInstance } from 'axios';
import type { SeriesMeta, Trace } from './fastCache';
import type { DetailRow, MetaRow, Quality, Stat } from './fastMeta';

/** A run's window on the log being plotted, in seconds from the log's start (the trace's time axis). */
export interface RunWindowBand { operationId: string; label: string; startS: number; endS: number; current: boolean }

/** The tabs of the run column. */
export type RunTab = 'stats' | 'detail' | 'recipe';

export interface RunQuality { level: Quality; label: string; hint: string }

/** A figure of the Statistics tab for profiles that show a summary instead of the FAST phases and energy. */
export interface SummaryTile { key: string; label: string; value: string; unit: string }

export interface RunProfile {
	key: 'fast' | 'conform';
	/** The nav name: "FAST plotter" | "Conform plotter". */
	title: string;
	/** The page heading shown in the host's view frame. */
	heading: string;
	/** localStorage key of the saved layout (tiles, selection, tab). */
	layoutKey: string;
	listQuery: { category: string; fields: string[] };
	/** Fields read for the selected operation. */
	detailFields: string[];
	/** Default tile groups, in order. */
	seedGroups: string[];
	/** The series a seeded tile draws, per group, when it is not simply the first few of the group. */
	seedSeries?: Record<string, string[]>;
	/** Seed only `seedGroups` (FAST also adds a tile for any other group, up to the tile limit). */
	seedStrict?: boolean;
	tabs: RunTab[];

	// ---- the run list
	quality(row: any): RunQuality;
	/** The parts of a list row's second line after the sample code and date. */
	listMeta(row: any): string[];

	// ---- the selected run
	/** The run's own record (fast_run_data row, or the Conform run + log), or null when it has none. */
	loadRun(api: AxiosInstance, operationId: string): Promise<unknown | null>;
	/** The trace to plot, or null when there is nothing to plot (not imported yet, no log, not visible). */
	loadTrace(api: AxiosInstance, run: unknown): Promise<Trace | null>;
	/** The series catalogue of the run's trace. */
	seriesOf(run: unknown): SeriesMeta[];
	buildOpMeta(op: any, run: unknown): MetaRow[];
	/** The figures under the run's identity: all of them; `peakLabels` and `factLabels` pick which go where. */
	buildStats(op: any, run: unknown): Stat[];
	peakLabels: string[];
	factLabels: string[];
	/** Replaces the default "measured from the trace" note under the peaks. */
	peaksNote?: string;
	/** Date, machine, operator ... under the identity. */
	headerFacts(op: any): MetaRow[];
	detailRows(op: any, run: unknown): DetailRow[];
	/** What the plot area says while the run has no trace to plot (`now` is epoch ms). */
	plotMessage(run: unknown, now: number): string;
	/** What the Statistics tab says when there is no trace. */
	noTraceMessage(run: unknown): string;
	/** The run's trace is ready, so the Statistics tab may wait for it rather than say there is none. */
	traceReady(run: unknown): boolean;

	// ---- only where the profile has them (Conform)
	/** The Statistics tab shows these figures instead of the FAST phases and energy chart. */
	summaryTiles?(op: any, run: unknown): SummaryTile[];
	/** Text under the figures (for example what was not measured). */
	summaryNote?(run: unknown): string | null;
	/** Is a data file linked to the run? Upload and "use a log already uploaded" are offered only when not. */
	hasLog?(run: unknown): boolean;
	/** A one-line statement of the run window for the actions panel, or null when none is set. */
	windowLabel?(run: unknown): string | null;
	/** Process a file and attach it. Resolves to a warning to show (or null), rejects with the message to show. */
	upload?(api: AxiosInstance, op: any, file: File): Promise<string | null>;
	/** Epoch ms of the trace's time zero, for hover clock times. */
	startMs?(run: unknown): number | null;
	/** Every run window on the run's log. */
	windows?(api: AxiosInstance, run: unknown): Promise<RunWindowBand[]>;
	setWindowFromView?(api: AxiosInstance, op: any, run: unknown, startS: number, endS: number): Promise<void>;
	linkExisting?: {
		list(api: AxiosInstance, op: any): Promise<{ id: string; label: string }[]>;
		link(api: AxiosInstance, op: any, id: string): Promise<void>;
	};
	/** The list quality of the run after it changed, to refresh its row. */
	runQuality?(run: unknown): RunQuality | null;
}
