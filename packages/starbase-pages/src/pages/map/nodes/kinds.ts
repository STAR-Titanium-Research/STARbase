// Kind -> label, icon and colour for the Process map's cards (spec §6.2). Icons are Material Symbols
// names for <v-icon> (the Directus component, or STARbase's stand-in that renders the same glyphs).
// Colours are the `--k-*` custom properties of mapTokens.css; stock lots and powder batches share the
// material colour because their wires carry stock.

import type { Kind, LineageRow, Ref } from '../model/types';
import './mapTokens.css';
import './nodes.css';

export interface KindStyle {
	label: string;
	icon: string;
	/** A `--k-*` custom property name (no var()). */
	color: string;
}

export const KINDS: Record<Kind, KindStyle> = {
	sample: { label: 'Sample', icon: 'science', color: '--k-sample' },
	operation: { label: 'Operation', icon: 'settings', color: '--k-op' },
	test: { label: 'Test', icon: 'fact_check', color: '--k-test' },
	stock_lot: { label: 'Stock lot', icon: 'inventory_2', color: '--k-material' },
	powder_batch: { label: 'Powder batch', icon: 'grain', color: '--k-material' },
	material: { label: 'Material', icon: 'layers', color: '--k-material' },
	equipment: { label: 'Machine', icon: 'precision_manufacturing', color: '--k-equipment' },
	tool: { label: 'Tool', icon: 'build', color: '--k-tool' },
	insert_edge: { label: 'Insert edge', icon: 'diamond', color: '--k-edge' },
	recipe: { label: 'Recipe', icon: 'receipt_long', color: '--k-recipe' },
	data_file: { label: 'Data file', icon: 'description', color: '--k-file' },
	person: { label: 'Person', icon: 'person', color: '--k-person' },
	campaign: { label: 'Campaign', icon: 'flag', color: '--k-campaign' },
	project: { label: 'Project', icon: 'folder_open', color: '--k-project' },
	junction: { label: 'Lineage', icon: 'content_cut', color: '--k-sample' },
};

/** The `--k` value for a style: `var(--k-sample)`. */
export const kindVar = (style: KindStyle): string => `var(${style.color})`;

/** Junction heading per lineage type (spec D10). */
export const LINEAGE_LABEL: Record<LineageRow['type'], string> = {
	cut_from: 'Cut from',
	sintered_from: 'Sintered from',
	powder_from: 'Powder from',
	derived_from: 'Derived from',
};

/**
 * Which status vocabulary a card's badge uses. Operations have no vocabulary of their own in the kit:
 * the campaign lifecycle (planned / active / complete / on hold) is the nearest, and any other value
 * still shows humanised in neutral.
 */
export function statusKindOf(kind: Kind): 'sample' | 'test' | 'campaign' {
	if (kind === 'sample') return 'sample';
	if (kind === 'test') return 'test';
	return 'campaign';
}

/** The kind a related record is drawn as in an Inside slot, from its collection; null when unknown. */
const BY_COLLECTION: Record<string, Kind> = {
	equipment: 'equipment',
	tools: 'tool',
	insert_edges: 'insert_edge',
	fast_recipes: 'recipe',
	prep_recipes: 'recipe',
	directus_files: 'data_file',
	// Force data is a file path on the operation, with no record of its own: drawn as a data file.
	force_file: 'data_file',
	people: 'person',
	directus_users: 'person',
	campaigns: 'campaign',
	projects: 'project',
	materials: 'material',
	raw_stock_lots: 'stock_lot',
};
export const kindOfCollection = (collection: string): Kind | null => BY_COLLECTION[collection] ?? null;

/** Collections whose records read better by name than by code in an Inside slot (a tool's code is a short hash, a campaign's a number). */
const BY_NAME: ReadonlySet<string> = new Set(['tools', 'campaigns']);
/** What an Inside slot shows for a record: its name for a tool or a campaign when it has one, else its code. */
export const slotText = (r: Pick<Ref, 'collection' | 'code' | 'label'>): string => (BY_NAME.has(r.collection) && r.label ? r.label : r.code);
