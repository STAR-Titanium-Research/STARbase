// Pinned-marker helpers for ForceChart (the "show position in time" line). Pure so the
// in-view rule and the tag text can be unit-tested without mounting the chart.

/** True when the pinned x sits inside the visible window [x0, x1] (a marker off-screen draws nothing). */
export function markInView(markX: number | null | undefined, x0: number, x1: number): markX is number {
	return markX != null && Number.isFinite(markX) && markX >= x0 && markX <= x1;
}

/** Tag text: the caller's label, else "t = <value> <unit>". `fmt` is the chart's own number formatter. */
export function markTagText(
	markX: number, label: string | undefined, xUnit: string | undefined, fmt: (v: number) => string,
): string {
	return label ?? `t = ${fmt(markX)} ${xUnit ?? ''}`.trim();
}
