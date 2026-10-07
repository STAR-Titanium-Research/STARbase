// Status vocabularies: label and tone per value, so every page shows the same words and colours.
//
// A tone, not a hex colour: StatusBadge maps it to Directus theme variables, so light and dark
// themes both work. The values mirror the database CHECK constraints:
//   test_sessions.status            20260619000013_status_vocabulary.sql
//   machining_force_analysis.status work-queue state (pending -> processing -> done | error | skipped)
//   machining_force_analysis.diag_status  null | pending | processing | done | error
//   physical_samples.current_status active | consumed | destroyed | archived
//   campaigns.status                free TEXT; the Data Studio form offers planned | active | complete |
//                                   on_hold, other values show humanised and neutral

export type Tone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export interface StatusStyle {
	label: string;
	tone: Tone;
}

export type StatusKind = 'test' | 'force' | 'diag' | 'sample' | 'campaign';

// The test-session lifecycle, defined once: every list below (chip order, "done" statuses, the
// matrix's worst-first rank and cell glyph, the badge styles) is derived from this table.
// `rank` orders statuses worst first (lowest = least advanced or failed), used to pick which test
// a matrix cell shows when several share it. `done` means the data is processed or analysed
// ('complete' was the retired pre-migration-0013 value and no longer exists).
interface TestLifecycleStep extends StatusStyle {
	value: string;
	done: boolean;
	rank: number;
	glyph: string;
}
const TEST_LIFECYCLE: ReadonlyArray<TestLifecycleStep> = [
	{ value: 'registered', label: 'Registered', tone: 'neutral', done: false, rank: 4, glyph: '–' },
	{ value: 'pending_processing', label: 'Pending processing', tone: 'info', done: false, rank: 3, glyph: '◷' },
	{ value: 'processing', label: 'Processing', tone: 'progress', done: false, rank: 1, glyph: '…' },
	{ value: 'processed', label: 'Processed', tone: 'success', done: true, rank: 5, glyph: '✓' },
	{ value: 'analysing', label: 'Analysing', tone: 'progress', done: false, rank: 2, glyph: '…' },
	{ value: 'analysed', label: 'Analysed', tone: 'success', done: true, rank: 6, glyph: '✓' },
	{ value: 'failed', label: 'Failed', tone: 'danger', done: false, rank: 0, glyph: '!' },
];

export const TEST_STATUS: Record<string, StatusStyle> = Object.fromEntries(
	TEST_LIFECYCLE.map((t) => [t.value, { label: t.label, tone: t.tone }]),
);
/** Statuses in lifecycle order (chip order). */
export const TEST_STATUS_ORDER: string[] = TEST_LIFECYCLE.map((t) => t.value);
/** A test counts as complete once its data is processed or analysed. */
export const TEST_DONE_STATUSES: string[] = TEST_LIFECYCLE.filter((t) => t.done).map((t) => t.value);
/** Worst first; an unknown status sorts with 'registered'. */
export const TEST_RANK: Record<string, number> = Object.fromEntries(TEST_LIFECYCLE.map((t) => [t.value, t.rank]));
/** The matrix cell glyph of a test status. */
export const TEST_GLYPH: Record<string, string> = Object.fromEntries(TEST_LIFECYCLE.map((t) => [t.value, t.glyph]));

export const FORCE_STATUS: Record<string, StatusStyle> = {
	pending: { label: 'Queued', tone: 'info' },
	processing: { label: 'Processing', tone: 'progress' },
	done: { label: 'Analysed', tone: 'success' },
	error: { label: 'Error', tone: 'danger' },
	skipped: { label: 'Skipped', tone: 'neutral' },
};

export const DIAG_STATUS: Record<string, StatusStyle> = {
	pending: { label: 'Diagnostics queued', tone: 'info' },
	processing: { label: 'Diagnostics building', tone: 'progress' },
	done: { label: 'Diagnostics built', tone: 'success' },
	error: { label: 'Diagnostics error', tone: 'danger' },
};

export const SAMPLE_STATUS: Record<string, StatusStyle> = {
	active: { label: 'Active', tone: 'success' },
	consumed: { label: 'Consumed', tone: 'warning' },
	destroyed: { label: 'Destroyed', tone: 'danger' },
	archived: { label: 'Archived', tone: 'neutral' },
};

export const CAMPAIGN_STATUS: Record<string, StatusStyle> = {
	planned: { label: 'Planned', tone: 'info' },
	active: { label: 'Active', tone: 'success' },
	complete: { label: 'Complete', tone: 'neutral' },
	on_hold: { label: 'On hold', tone: 'warning' },
};

const VOCABULARIES: Record<StatusKind, Record<string, StatusStyle>> = {
	test: TEST_STATUS,
	force: FORCE_STATUS,
	diag: DIAG_STATUS,
	sample: SAMPLE_STATUS,
	campaign: CAMPAIGN_STATUS,
};

// "pending_processing" -> "Pending processing"
export function humanise(value: string): string {
	const text = value.replace(/_/g, ' ').trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// A value outside the vocabulary (a status added by a later migration) still shows, in neutral,
// rather than disappearing. A missing value is null: callers render nothing.
export function statusStyle(kind: StatusKind, value: string | null | undefined): StatusStyle | null {
	if (value === null || value === undefined || value === '') return null;
	return VOCABULARIES[kind][value] ?? { label: humanise(value), tone: 'neutral' };
}
