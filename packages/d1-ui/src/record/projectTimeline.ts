// The Project page's timeline as a pure model (spec docs/superpowers/specs/2026-10-20-project-page-hero-design.md, "Timeline"):
// dates in, a description of what to draw out. No Vue, no pixels: ProjectTimeline.vue maps `domain` to its width.
//
// All dates are read as LOCAL calendar days (a date-only string like 2026-10-09 is that day, not UTC midnight, so it never slips to the
// day before in a negative-offset zone), and every time in the model is the epoch ms of a local midnight.
// Weeks are the ISO weeks of activity.ts, binned by the Monday that starts them.

import { isoWeek, isoWeekLabel, weekStart } from '../activity';

export type TimelineRange = '30d' | '6mo' | 'all';

export const RANGE_OPTIONS: readonly { value: TimelineRange; label: string }[] = [
	{ value: '30d', label: '30 d' },
	{ value: '6mo', label: '6 mo' },
	{ value: 'all', label: 'All' },
];

const RANGE_DAYS: Record<Exclude<TimelineRange, 'all'>, number> = { '30d': 30, '6mo': 182 };
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A planned date with how many records fall on it. */
export type PlannedInput = { date: string; n: number };

export interface TimelineCampaignInput {
	id: string;
	code: string;
	name: string;
	status: string;
	start: string | null;
	end: string | null;
}

export interface TimelineInput {
	project: { start: string | null; end: string | null };
	campaigns: readonly TimelineCampaignInput[];
	/** Dates of the done operations and tests. */
	ops: readonly (string | null | undefined)[];
	tests: readonly (string | null | undefined)[];
	plannedOps: readonly PlannedInput[];
	plannedTests: readonly PlannedInput[];
	today: Date;
	range: TimelineRange;
	/** About how many x labels fit; the month (or week) step grows until they do. Default 8. */
	xTickBudget?: number;
}

/** What `projectTimeline` needs apart from the x tick budget (the part that does not depend on the drawn width). */
export type TimelineDataInput = Omit<TimelineInput, 'xTickBudget'>;

export interface TimelineBar { start: number; end: number; openEnd: boolean }
export interface TimelineCampaignRow { id: string; code: string; name: string; status: string; start: number; end: number }
export interface TimelineWeek { ms: number; ops: number; tests: number }
export interface TimelineMarker { date: number; kind: 'op' | 'test'; n: number }
export interface TimelineTick { ms: number; label: string }

export interface TimelineModel {
	domain: [number, number];
	today: number;
	/** The project's own bar clipped to the domain; null when the project lies wholly outside it. */
	project: TimelineBar | null;
	/** Dated campaigns overlapping the domain, earliest start first. Their dates are not clipped. */
	campaigns: TimelineCampaignRow[];
	/** Codes of campaigns without both dates (all of them, whatever the range). */
	undated: string[];
	/** Weeks in range that have done work, oldest first. */
	weeks: TimelineWeek[];
	planned: TimelineMarker[];
	/** y axis: ticks from 0 up to `top`, which is above the busiest week. */
	y: { top: number; step: number; ticks: number[] };
	xTicks: TimelineTick[];
	empty: boolean;
	/** The newest done operation / test, over all dates (not only the range). */
	lastOp: number | null;
	lastTest: number | null;
}

/** A date or timestamp as the epoch ms of its local calendar day; null when empty or unparseable. */
export function dayOf(value: string | Date | null | undefined): number | null {
	if (value === null || value === undefined || value === '') return null;
	const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
	const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "9 Oct 2026". */
export function dayLabel(ms: number): string {
	const d = new Date(ms);
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The empty chart's sentence. */
export function emptyText(range: TimelineRange): string {
	const when = range === '30d' ? 'the last 30 days' : range === '6mo' ? 'the last 6 months' : 'the project';
	return `No operations or tests in ${when}.`;
}

/** A tick step of 1, 2, 2.5 or 5 times a power of ten (a whole number, at least 1) that gives about four intervals up to `max`. */
export function niceStep(max: number): number {
	const raw = max / 4;
	if (!(raw >= 1)) return 1;
	const p = 10 ** Math.floor(Math.log10(raw));
	for (const s of [1, 2, 2.5, 5, 10]) {
		const step = s * p;
		if (step >= raw - 1e-12 && Number.isInteger(step)) return step;
	}
	return 10 * p;
}

/** Ticks 0, step, ... up to a top strictly above `max`. */
export function yAxis(max: number): TimelineModel['y'] {
	const step = niceStep(max);
	const top = Math.ceil((max + 1e-9) / step) * step;
	const ticks: number[] = [];
	for (let i = 0; i * step <= top; i++) ticks.push(i * step);
	return { top, step, ticks };
}

// Math.min / Math.max spread their arguments, which overflows the stack on a very long list.
const minOf = (xs: number[]): number => xs.reduce((a, b) => (b < a ? b : a), Infinity);
const maxOf = (xs: number[]): number => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

const addDays = (ms: number, n: number): number => {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
const mondayOf = (ms: number): number => weekStart(new Date(ms)).getTime();

function plannedDays(list: readonly PlannedInput[], kind: 'op' | 'test'): TimelineMarker[] {
	const byDay = new Map<number, number>();
	for (const p of list) {
		const date = dayOf(p.date);
		if (date === null) continue;
		const n = Math.max(0, Math.floor(p.n));
		if (n > 0) byDay.set(date, (byDay.get(date) ?? 0) + n);
	}
	return [...byDay].sort((a, b) => a[0] - b[0]).map(([date, n]) => ({ date, kind, n }));
}

/** The x axis labels for a domain: weekly Mondays up to about two months, else the 1st of every 1, 2, 3, 6 or 12 months. */
export function timelineXTicks([x0, x1]: [number, number], budget = 8): TimelineTick[] {
	budget = Math.max(2, budget);
	const span = (x1 - x0) / DAY;
	const out: TimelineTick[] = [];
	if (span <= 62) {
		// Weekly: the Mondays inside the domain, every second or fourth one when they would crowd.
		const mondays: number[] = [];
		for (let t = addDays(mondayOf(x0), 7); t < x1; t = addDays(t, 7)) mondays.push(t);
		const every = mondays.length <= budget ? 1 : mondays.length <= budget * 2 ? 2 : 4;
		mondays.filter((_, i) => i % every === 0).forEach((t) => out.push({ ms: t, label: `${new Date(t).getDate()} ${MONTHS[new Date(t).getMonth()]}` }));
		return out;
	}
	// Months: the 1st of every 1, 2, 3, 6 (or 12) months, the smallest step whose labels fit.
	const months = span / 30.4;
	const step = [1, 2, 3, 6, 12].find((s) => months / s <= budget) ?? 12;
	let m = new Date(new Date(x0).getFullYear(), new Date(x0).getMonth() + 1, 1);
	while (m.getMonth() % step) m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
	for (; m.getTime() < x1; m = new Date(m.getFullYear(), m.getMonth() + step, 1)) {
		const first = out.length === 0;
		out.push({ ms: m.getTime(), label: `${MONTHS[m.getMonth()]}${first || m.getMonth() === 0 ? ` ${m.getFullYear()}` : ''}` });
	}
	return out;
}

/** Everything in the model but the x ticks: parses and bins the dates. The x ticks (`timelineXTicks`) follow the width, this does not. */
export function timelineData(input: TimelineDataInput): Omit<TimelineModel, 'xTicks'> {
	const today = dayOf(input.today) ?? Date.now();
	const days = (list: readonly (string | null | undefined)[]) => list.map((v) => dayOf(v)).filter((v): v is number => v !== null);
	const opDays = days(input.ops);
	const testDays = days(input.tests);
	const plannedOps = plannedDays(input.plannedOps, 'op');
	const plannedTests = plannedDays(input.plannedTests, 'test');
	const pStart = dayOf(input.project.start);
	const pEnd = dayOf(input.project.end);

	let x0: number;
	let x1: number;
	if (input.range === 'all') {
		const records = [...opDays, ...testDays, ...plannedOps.map((p) => p.date), ...plannedTests.map((p) => p.date)];
		// A record older than the project's recorded start still belongs on the chart, so the start is the earlier of the two.
		const first = [...(pStart !== null ? [pStart] : []), ...(records.length ? [minOf(records)] : [])];
		x0 = mondayOf(first.length ? minOf(first) : addDays(today, -30));
		const later = Math.max(today, pEnd ?? 0, maxOf(records));
		x1 = Math.max(later, x0 + DAY);
		x1 += (x1 - x0) * 0.04;
	} else {
		const n = RANGE_DAYS[input.range];
		x0 = mondayOf(addDays(today, -n));
		x1 = today + n * DAY * 0.25;
	}
	const inRange = (ms: number) => ms >= x0 && ms <= x1;

	// Project bar: no start runs from the left edge, no end runs to today (openEnd; the page fades it).
	let project: TimelineBar | null = null;
	const barStart = pStart ?? x0;
	const barEnd = pEnd ?? Math.max(today, barStart);
	if (barEnd >= x0 && barStart <= x1) {
		project = { start: Math.max(barStart, x0), end: Math.min(barEnd, x1), openEnd: pEnd === null };
	}

	const campaigns: TimelineCampaignRow[] = [];
	const undated: string[] = [];
	for (const c of input.campaigns) {
		const a = dayOf(c.start);
		const b = dayOf(c.end);
		if (a === null || b === null) {
			undated.push(c.code);
			continue;
		}
		const start = Math.min(a, b);
		const end = Math.max(a, b);
		if (end >= x0 && start <= x1) campaigns.push({ id: c.id, code: c.code, name: c.name, status: c.status, start, end });
	}
	campaigns.sort((a, b) => a.start - b.start || a.code.localeCompare(b.code, undefined, { numeric: true }));

	const bins = new Map<number, TimelineWeek>();
	const bin = (list: number[], key: 'ops' | 'tests') => {
		for (const d of list.filter(inRange)) {
			const ms = mondayOf(d);
			const w = bins.get(ms) ?? { ms, ops: 0, tests: 0 };
			w[key] += 1;
			bins.set(ms, w);
		}
	};
	bin(opDays, 'ops');
	bin(testDays, 'tests');
	const weeks = [...bins.values()].sort((a, b) => a.ms - b.ms);
	const planned = [...plannedOps, ...plannedTests].filter((p) => inRange(p.date)).sort((a, b) => a.date - b.date);

	const busiest = Math.max(1, maxOf(weeks.map((w) => w.ops + w.tests)));
	return {
		domain: [x0, x1],
		today,
		project,
		campaigns,
		undated,
		weeks,
		planned,
		y: yAxis(busiest),
		empty: weeks.length === 0 && planned.length === 0 && campaigns.length === 0,
		lastOp: opDays.length ? maxOf(opDays) : null,
		lastTest: testDays.length ? maxOf(testDays) : null,
	};
}

export function projectTimeline(input: TimelineInput): TimelineModel {
	const data = timelineData(input);
	return { ...data, xTicks: timelineXTicks(data.domain, input.xTickBudget) };
}

/** The ISO week label of a week bar ("2026-W42"), for the screen-reader table and tooltips. */
export function weekLabel(w: Pick<TimelineWeek, 'ms'>): string {
	return isoWeekLabel(isoWeek(new Date(w.ms)));
}
