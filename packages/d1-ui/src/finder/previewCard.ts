import { choiceLabel } from '../choiceLabels';
import { asRecord, formatDate, formatNumber } from '../format';
import type { NavIconName } from '../nav/navIcons';
import { operationKind, operationRailFacts, sampleFact } from '../record/operationFacts';
import type { Fact } from '../record/facts';
import { sampleKind, sampleRailFacts } from '../record/sampleFacts';
import { humanise } from '../status';
import { FINDER_SOURCES } from './finder';
import type { FinderHit } from './finder';

// The finder's preview card, kept free of Vue and of the host so it can be tested on its own. The pane (FinderPreview.vue) draws a PreviewCard; usePreview
// asks for the fields a collection's card needs (previewRequest), reads the record with them and turns it into the card (buildCard). The part of the card that
// needs no request (label, kind, detail and the "matched in" line) comes from the hit itself (instantCard) and is shown while the record loads.
//
// The fields are a small, checked subset of what the record pages already read (useSampleData, useOperationData, useTestData and the index columns): one field
// the role may not read makes Directus refuse the whole request, and the card would then never show.
// A relation a reader may not see arrives as a bare id (or null): it is never printed as one. A project says "Not visible to you", an owner or a sample
// that is simply absent is left out.

export interface PreviewFact {
	label: string;
	value: string;
	mono?: boolean;
}

export interface PreviewCard {
	icon: NavIconName;
	title: string;
	kind: string;
	detail?: string;
	facts: PreviewFact[];
	// A pass 2 hit: the field the words were found in and, for a field on the row itself, a piece of its value.
	matched?: { field: string; snippet?: string };
}

type Rec = Record<string, any>;

interface CardDef {
	icon: NavIconName;
	kind: string;
	// What to GET (besides what the hit already says): enough for the facts, nothing more.
	fields: string[];
	// The record's kind line and facts. Only called with an object row.
	build(row: Rec): { kind?: string; facts: Fact[] };
}

const HIDDEN_TEXT = 'Not visible to you';
const yesNo = (v: unknown): string => (v === true ? 'Yes' : v === false ? 'No' : '');
const when = (v: unknown): string => (typeof v === 'string' ? formatDate(v) : '');
const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

// A file size as a person reads it (the Inbox's own sizeText lives in a page package this kit cannot import).
export function bytesText(bytes: unknown): string {
	const n = typeof bytes === 'string' && bytes.trim() ? Number(bytes) : bytes;
	if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB'];
	let v = n / 1024;
	let i = 0;
	for (; v >= 1024 && i < units.length - 1; i++) v /= 1024;
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// The facts with these labels, in this order (a missing one is skipped).
const pick = (facts: Fact[], labels: string[]): Fact[] => labels.flatMap((l) => facts.filter((f) => f.label === l));

const CARDS: Record<string, CardDef> = {
	physical_samples: {
		icon: 'test-tube',
		kind: 'Sample',
		fields: [
			'sample_id', 'form', 'current_status', 'location', 'mass_grams',
			'material_id.alloy_code', 'material_id.common_name',
			'project_id.project_id', 'project_id.project_code',
			'owner_person_id.full_name', 'owner_team_id.name',
		],
		build(row) {
			// The rail's facts (a project that came back as a bare id reads as hidden there); the dimensions, co-owners and campaigns are not read.
			const rail = sampleRailFacts(row, '', [], {});
			return {
				kind: sampleKind(row),
				facts: [
					...pick(rail, ['Material']),
					{ label: 'Geometry', value: choiceLabel('geometry', row.form) },
					{ label: 'Status', value: row.current_status ? humanise(String(row.current_status)) : '' },
					...pick(rail, ['Owner', 'Location', 'Project', 'Mass']),
				],
			};
		},
	},
	equipment: {
		icon: 'drill',
		kind: 'Equipment',
		fields: ['equipment_id', 'equipment_type', 'location', 'is_active', 'manufacturer', 'facility_id.name'],
		build: (row) => ({
			facts: [
				{ label: 'Type', value: choiceLabel('equipmentType', row.equipment_type) },
				{ label: 'Manufacturer', value: row.manufacturer },
				{ label: 'Facility', value: asRecord(row.facility_id)?.name },
				{ label: 'Location', value: row.location },
				{ label: 'Active', value: yesNo(row.is_active) },
			],
		}),
	},
	manufacturing_operations: {
		icon: 'cog',
		kind: 'Operation',
		fields: [
			'operation_id', 'operation_date', 'process_category', 'operator_name',
			'method_id.method_name', 'equipment_id.equipment_name', 'operator_person_id.full_name',
			'sample_id.sample_id', 'sample_id.sample_code',
		],
		build: (row) => ({
			kind: operationKind(row),
			facts: pick(operationRailFacts(row, {}), ['Method', 'Sample', 'Machine', 'Operator', 'Date']),
		}),
	},
	test_sessions: {
		icon: 'clipboard-check',
		kind: 'Test',
		fields: ['session_id', 'test_type', 'status', 'session_date', 'sample_id.sample_id', 'sample_id.sample_code'],
		build(row) {
			const sample = asRecord(row.sample_id);
			return {
				facts: [
					{ label: 'Type', value: row.test_type ? humanise(String(row.test_type)) : '' },
					{ label: 'Status', value: row.status ? humanise(String(row.status)) : '' },
					// A sample that came back as a bare id was not readable.
					sampleFact(sample, !sample && !!row.sample_id),
					{ label: 'Date', value: when(row.session_date) },
				],
			};
		},
	},
	directus_files: {
		icon: 'inbox',
		kind: 'File',
		// The owner is not here (owner_person_id has no Directus relation, so /files cannot read its name) and neither is a thumbnail: the d1-inbox
		// picture route is keyed by a candidate id, which a /files hit does not carry.
		fields: ['id', 'type', 'filesize', 'uploaded_on', 'metadata'],
		build(row) {
			const meta = asRecord(row.metadata);
			return {
				facts: [
					{ label: 'Type', value: row.type },
					{ label: 'Size', value: bytesText(row.filesize) },
					{ label: 'Uploaded', value: when(row.uploaded_on) },
					{ label: 'Archive path', value: typeof meta?.archive_path === 'string' ? meta.archive_path : '', mono: true },
				],
			};
		},
	},
	materials: {
		icon: 'layers',
		kind: 'Material',
		fields: ['material_id', 'common_name', 'density_g_per_cm3'],
		build: (row) => ({
			facts: [
				{ label: 'Name', value: row.common_name },
				{ label: 'Density', value: formatNumber(row.density_g_per_cm3, 'g/cm³') },
			],
		}),
	},
	campaigns: {
		icon: 'flag',
		kind: 'Campaign',
		fields: ['campaign_id', 'campaign_type', 'status'],
		build: (row) => ({
			facts: [
				{ label: 'Status', value: row.status ? humanise(String(row.status)) : '' },
				{ label: 'Type', value: row.campaign_type ? humanise(String(row.campaign_type)) : '' },
			],
		}),
	},
	projects: {
		icon: 'folder',
		kind: 'Project',
		fields: ['project_id', 'principal_investigator_name', 'is_active'],
		build: (row) => ({
			facts: [
				{ label: 'Principal investigator', value: row.principal_investigator_name },
				{ label: 'Active', value: yesNo(row.is_active) },
			],
		}),
	},
	people: {
		icon: 'users',
		kind: 'Person',
		fields: ['person_id', 'is_operator', 'is_researcher', 'active'],
		build: (row) => ({
			facts: [
				{ label: 'Role', value: [row.is_operator ? 'Operator' : '', row.is_researcher ? 'Researcher' : ''].filter(Boolean).join(', ') },
				{ label: 'Active', value: yesNo(row.active) },
			],
		}),
	},
	tools: {
		icon: 'wrench',
		kind: 'Tool',
		fields: ['tool_id', 'tool_name', 'tool_type'],
		build: (row) => ({ facts: [{ label: 'Name', value: row.tool_name }, { label: 'Type', value: row.tool_type }] }),
	},
	tool_boxes: {
		icon: 'briefcase',
		kind: 'Tool box',
		fields: ['tool_box_id', 'description', 'location'],
		build: (row) => ({ facts: [{ label: 'Description', value: row.description }, { label: 'Location', value: row.location }] }),
	},
	cutting_inserts: {
		icon: 'diamond',
		kind: 'Cutting insert',
		fields: ['insert_id', 'location', 'is_depleted'],
		build: (row) => ({ facts: [{ label: 'Location', value: row.location }, { label: 'Depleted', value: yesNo(row.is_depleted) }] }),
	},
	insert_edges: {
		icon: 'triangle-right',
		kind: 'Insert edge',
		fields: ['edge_id', 'edge_identifier', 'is_used'],
		build: (row) => ({ facts: [{ label: 'Edge', value: row.edge_identifier }, { label: 'Used', value: yesNo(row.is_used) }] }),
	},
	raw_stock_lots: {
		icon: 'cylinder',
		kind: 'Raw stock lot',
		fields: ['lot_id', 'supplier_name', 'remaining_mass_grams'],
		build: (row) => ({
			facts: [{ label: 'Supplier', value: row.supplier_name }, { label: 'Remaining', value: formatNumber(row.remaining_mass_grams, 'g') }],
		}),
	},
};

// The key a card is cached and watched by; null for a hit that is not a record (Pages, Saved views, "More in").
export function previewKey(hit: Pick<FinderHit, 'record' | 'more'> | null | undefined): string | null {
	return hit?.record && !hit.more && CARDS[hit.record.collection] ? `${hit.record.collection}:${hit.record.id}` : null;
}

// What to GET for a record's card, or null for a collection that has no card.
export function previewRequest(collection: string, id: string): { path: string; fields: string[] } | null {
	const def = CARDS[collection];
	if (!def) return null;
	// Files have an endpoint of their own (the finder's own source says which).
	const base = FINDER_SOURCES.find((s) => s.collection === collection)?.path ?? `/items/${collection}`;
	return { path: `${base}/${encodeURIComponent(id)}`, fields: def.fields };
}

// The card as far as the hit alone can say it: nothing is invented, and no relation is read. null for a hit that has no card.
export function instantCard(hit: FinderHit): PreviewCard | null {
	if (!previewKey(hit)) return null;
	const def = CARDS[hit.record!.collection];
	const card: PreviewCard = { icon: def.icon, title: hit.label, kind: def.kind, facts: [] };
	// The inventory hits say their kind as their detail already.
	if (hit.detail && hit.detail !== def.kind) card.detail = hit.detail;
	if (hit.matchedIn) card.matched = hit.matchedSnippet ? { field: hit.matchedIn, snippet: hit.matchedSnippet } : { field: hit.matchedIn };
	return card;
}

// The finished card: the instant part plus the record's kind line and facts (the empty ones left out). A row that is not an object gives just the instant part.
export function buildCard(hit: FinderHit, row: unknown): PreviewCard | null {
	const card = instantCard(hit);
	const rec = asRecord(row);
	if (!card || !rec) return card;
	const built = CARDS[hit.record!.collection].build(rec);
	if (built.kind) card.kind = built.kind;
	card.facts = built.facts.flatMap((f) => {
		const value = f.hidden ? HIDDEN_TEXT : text(f.value);
		return value ? [{ label: f.label, value, mono: f.mono }] : [];
	});
	return card;
}
