// Process categories of manufacturing_operations (CHECK constraint on process_category) and the
// analysis dashboard each one is read in.

export const PROCESS_LABEL: Record<string, string> = {
	machining: 'Machining',
	sintering: 'FAST sintering',
	conform: 'Conform',
	heat_treatment: 'Heat treatment',
	deformation: 'Deformation',
	additive: 'Additive',
	sample_prep: 'Sample preparation',
};

export function processLabel(category: string | null | undefined): string {
	if (!category) return 'Operation';
	return PROCESS_LABEL[category] ?? category.replace(/_/g, ' ');
}

export interface AnalysisLink {
	label: string;
	to: string;
}

// Machining operations are read in the Force dashboard, FAST (sintering) runs in the FAST
// dashboard and Conform runs in the Conform plotter (the FAST plotter with a profile; it has no
// Data Studio form, so the link is its STARbase path, which links.ts lists as a local page). Nothing
// else has an analysis page. The dashboards open the operation from `?operation=`.
export function analysisLink(operationId: string, category: string | null | undefined): AnalysisLink | null {
	const id = encodeURIComponent(operationId);
	if (category === 'machining') return { label: 'View forces', to: `/d1-force-dashboard?operation=${id}` };
	if (category === 'sintering') return { label: 'View FAST', to: `/d1-fast-dashboard?operation=${id}` };
	if (category === 'conform') return { label: 'View Conform', to: `/plot/conform?operation=${id}` };
	return null;
}
