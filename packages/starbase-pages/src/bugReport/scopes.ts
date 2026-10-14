// The pickers of the Report a bug page. Keep AREAS and PAGES in sync with the endpoint's
// (core/extensions/d1-bug-report-endpoint/index.js): it drops any area or page not listed there.
// "Records" is not listed here: its options are STARbase's own list pages (INDEX_DEFS).
import { INDEX_DEFS, indexDefBySlug } from '@d1/ui';

export interface Option {
	value: string;
	label: string;
}

export const AREAS: Option[] = [
	{ value: 'data-entry', label: 'Records (samples, operations, tests, ...)' },
	{ value: 'dashboards', label: 'Plots and dashboards' },
	{ value: 'reports', label: 'Reports and labels' },
	{ value: 'access', label: 'Login and permissions' },
	{ value: 'general', label: 'Something else' },
];

export const PAGES: Record<string, Option[]> = {
	dashboards: [
		{ value: 'home', label: 'Home' },
		{ value: 'force-plot', label: 'Force plot' },
		{ value: 'fast-plot', label: 'Fast-sampling plot' },
		{ value: 'force-crawler', label: 'Force crawler' },
	],
	reports: [
		{ value: 'sample-overview', label: 'Sample overview' },
		{ value: 'operation-report', label: 'Operation report' },
		{ value: 'test-report', label: 'Test report' },
		{ value: 'print-labels', label: 'Print labels' },
	],
	access: [
		{ value: 'login', label: 'Logging in' },
		{ value: 'permissions', label: 'Something I cannot see or edit' },
		{ value: 'account', label: 'My account' },
	],
};

// The collections a person can say a record problem was in: every list page STARbase has.
export function collectionOptions(): Option[] {
	return INDEX_DEFS.map((d) => ({ value: d.collection, label: d.title })).sort((a, b) => a.label.localeCompare(b.label));
}

export function scopeOptions(area: string): Option[] {
	return area === 'data-entry' ? collectionOptions() : (PAGES[area] ?? []);
}

export const scopeQuestion = (area: string): string => (area === 'data-entry' ? 'Which list?' : 'Which page?');

// Where the reporter probably was, from the route they opened this page from (STARbase routes, no
// /home prefix): so the pickers start on the right answer. They can still change both.
export function suggestFromRoute(route: string): { area: string; scope: string } | null {
	const path = route.split(/[?#]/)[0] ?? '';
	if (path === '/') return { area: 'dashboards', scope: 'home' };
	const [first, second] = path.split('/').filter(Boolean);
	if (first === 'plot') {
		if (second === 'force') return { area: 'dashboards', scope: 'force-plot' };
		if (second === 'fast') return { area: 'dashboards', scope: 'fast-plot' };
		return { area: 'dashboards', scope: '' };
	}
	if (first === 'crawler') return { area: 'dashboards', scope: 'force-crawler' };
	if (first === 'labels') return { area: 'reports', scope: 'print-labels' };
	const def = first ? indexDefBySlug(first) : undefined;
	return def ? { area: 'data-entry', scope: def.collection } : null;
}
