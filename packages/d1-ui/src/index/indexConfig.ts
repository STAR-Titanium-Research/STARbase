// One entry per index page, from the column table of the navigation spec (section 5.1). The generic
// IndexPage reads these; adding a collection's list page is one entry here plus one nav link.
//
// Projects and People are not here: they keep their bespoke pages and only gain the sidebar.

export interface ColumnDef {
	// A column of the collection (the relation's foreign key when `relation` is set).
	field: string;
	label: string;
	format?: 'date' | 'bool' | 'number' | 'code';
	// Show the related row by this field instead of the raw key.
	relation?: { collection: string; display: string };
}

export interface FilterDef {
	field: string;
	label: string;
	// relation / enum options are loaded at runtime, so an enum need not list its values.
	// `fallback`: a second field that labels a row whose `display` is empty (a campaign without a code is named).
	options: { kind: 'relation'; collection: string; display: string; fallback?: string } | { kind: 'enum'; values?: string[] } | { kind: 'bool' };
}

export interface IndexDef {
	// URL: /home/<slug>
	slug: string;
	collection: string;
	title: string;
	group: 'records' | 'inventory' | 'resources';
	primaryKey: string;
	columns: ColumnDef[];
	// The search box ORs _icontains over these; dotted paths reach through a relation.
	searchFields: string[];
	filters: FilterDef[];
	// Always ANDed into the query (none planned today).
	fixedFilter?: Record<string, unknown>;
	// A field, with a leading '-' for descending.
	defaultSort: string;
	// record = its Explorer page; drawer = the edit drawer over the list.
	rowTarget: 'record' | 'drawer';
	// The collection has a short_id column the finder can match exactly.
	hasShortId?: boolean;
	// Rows can be ticked, and one button sends the ticked keys to an app page as ?<param>=a,b,c.
	selectAction?: SelectAction;
}

export interface SelectAction {
	label: string;
	// An app route without the host's base path, e.g. '/home/labels'.
	path: string;
	// The query parameter that carries the keys.
	param: string;
}

const col = (field: string, label: string, format?: ColumnDef['format']): ColumnDef => (format ? { field, label, format } : { field, label });
const rel = (field: string, label: string, collection: string, display: string): ColumnDef => ({ field, label, relation: { collection, display } });
const relFilter = (field: string, label: string, collection: string, display: string, fallback?: string): FilterDef => ({
	field, label, options: fallback ? { kind: 'relation', collection, display, fallback } : { kind: 'relation', collection, display },
});
const enumFilter = (field: string, label: string): FilterDef => ({ field, label, options: { kind: 'enum' } });
const boolFilter = (field: string, label: string): FilterDef => ({ field, label, options: { kind: 'bool' } });

const project = relFilter('project_id', 'Project', 'projects', 'project_code');
const campaign = relFilter('campaign_id', 'Campaign', 'campaigns', 'campaign_code', 'name');
const material = relFilter('material_id', 'Material', 'materials', 'alloy_code');
const insertType = relFilter('insert_type_id', 'Insert type', 'insert_types', 'type_code');
const processCategory = enumFilter('process_category', 'Process category');

export const INDEX_DEFS: IndexDef[] = [
	{
		slug: 'campaigns', collection: 'campaigns', title: 'Campaigns', group: 'records', primaryKey: 'campaign_id',
		columns: [
			col('campaign_code', 'Code', 'code'), col('name', 'Name'),
			rel('project_id', 'Project', 'projects', 'project_code'),
			col('campaign_type', 'Type'), col('status', 'Status'),
			col('start_date', 'Start', 'date'), col('end_date', 'End', 'date'),
		],
		searchFields: ['campaign_code', 'name'],
		filters: [project, enumFilter('status', 'Status'), enumFilter('campaign_type', 'Type')],
		defaultSort: '-start_date', rowTarget: 'record',
	},
	{
		slug: 'samples', collection: 'physical_samples', title: 'Samples', group: 'records', primaryKey: 'sample_id',
		columns: [
			col('sample_code', 'Code', 'code'), col('nickname', 'Nickname'),
			rel('material_id', 'Material', 'materials', 'alloy_code'),
			rel('project_id', 'Project', 'projects', 'project_code'),
			col('form', 'Form'), col('current_status', 'Status'), col('location', 'Location'),
			col('created_at', 'Created', 'date'),
		],
		searchFields: ['sample_code', 'nickname'],
		filters: [project, enumFilter('current_status', 'Status'), material],
		defaultSort: '-created_at', rowTarget: 'record', hasShortId: true,
		selectAction: { label: 'Print labels for selected', path: '/home/labels', param: 'ids' },
	},
	{
		slug: 'operations', collection: 'manufacturing_operations', title: 'Operations', group: 'records', primaryKey: 'operation_id',
		columns: [
			col('pass_code', 'Code', 'code'),
			rel('sample_id', 'Sample', 'physical_samples', 'sample_code'),
			rel('method_id', 'Method', 'manufacturing_methods', 'method_code'),
			rel('equipment_id', 'Equipment', 'equipment', 'equipment_name'),
			col('operation_date', 'Date', 'date'), col('operator_name', 'Operator'), col('outcome_notes', 'Outcome'),
		],
		searchFields: ['pass_code', 'sample_id.sample_code', 'operator_name'],
		filters: [project, campaign, relFilter('method_id', 'Method', 'manufacturing_methods', 'method_code'), processCategory],
		defaultSort: '-operation_date', rowTarget: 'record', hasShortId: true,
	},
	{
		slug: 'tests', collection: 'test_sessions', title: 'Tests', group: 'records', primaryKey: 'session_id',
		columns: [
			col('test_code', 'Code', 'code'), col('test_type', 'Type'),
			rel('sample_id', 'Sample', 'physical_samples', 'sample_code'),
			col('session_date', 'Date', 'date'), col('status', 'Status'),
			rel('equipment_id', 'Equipment', 'equipment', 'equipment_name'),
		],
		searchFields: ['test_code', 'test_type', 'sample_id.sample_code'],
		filters: [project, campaign, enumFilter('test_type', 'Type'), enumFilter('status', 'Status')],
		defaultSort: '-session_date', rowTarget: 'record', hasShortId: true,
	},
	{
		slug: 'tools', collection: 'tools', title: 'Tools', group: 'inventory', primaryKey: 'tool_id',
		columns: [
			col('tool_code', 'Code', 'code'), col('tool_name', 'Name'), col('tool_type', 'Type'),
			rel('manufacturer_id', 'Manufacturer', 'manufacturers', 'name'),
			col('is_active', 'Active', 'bool'),
		],
		searchFields: ['tool_code', 'tool_name'],
		filters: [enumFilter('tool_type', 'Type'), boolFilter('is_active', 'Active')],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'tool-boxes', collection: 'tool_boxes', title: 'Tool boxes', group: 'inventory', primaryKey: 'tool_box_id',
		columns: [
			col('tool_box_code', 'Code', 'code'), col('description', 'Description'),
			rel('insert_type_id', 'Insert type', 'insert_types', 'type_code'),
			col('location', 'Location'), col('package_quantity', 'Qty', 'number'),
		],
		searchFields: ['tool_box_code', 'description'],
		filters: [insertType, project],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'inserts', collection: 'cutting_inserts', title: 'Cutting inserts', group: 'inventory', primaryKey: 'insert_id',
		columns: [
			col('insert_code', 'Code', 'code'),
			rel('tool_box_id', 'Tool box', 'tool_boxes', 'tool_box_code'),
			rel('insert_type_id', 'Insert type', 'insert_types', 'type_code'),
			col('insert_number', 'No.', 'number'), col('is_depleted', 'Depleted', 'bool'), col('location', 'Location'),
		],
		searchFields: ['insert_code'],
		filters: [insertType, boolFilter('is_depleted', 'Depleted')],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'edges', collection: 'insert_edges', title: 'Insert edges', group: 'inventory', primaryKey: 'edge_id',
		columns: [
			col('edge_code', 'Code', 'code'),
			rel('insert_id', 'Insert', 'cutting_inserts', 'insert_code'),
			col('edge_identifier', 'Edge'), col('is_used', 'Used', 'bool'),
		],
		searchFields: ['edge_code'],
		filters: [boolFilter('is_used', 'Used')],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'stock-lots', collection: 'raw_stock_lots', title: 'Raw stock lots', group: 'inventory', primaryKey: 'lot_id',
		columns: [
			col('lot_code', 'Code', 'code'), col('stock_type', 'Type'),
			rel('material_id', 'Material', 'materials', 'alloy_code'),
			col('supplier_name', 'Supplier'), col('remaining_mass_grams', 'Remaining (g)', 'number'),
			col('received_date', 'Received', 'date'),
		],
		searchFields: ['lot_code', 'supplier_name'],
		filters: [enumFilter('stock_type', 'Type'), material],
		defaultSort: '-received_date', rowTarget: 'drawer',
	},
	{
		slug: 'equipment', collection: 'equipment', title: 'Equipment', group: 'resources', primaryKey: 'equipment_id',
		columns: [
			col('equipment_code', 'Code', 'code'), col('equipment_name', 'Name'), col('equipment_type', 'Type'),
			rel('facility_id', 'Facility', 'facilities', 'name'),
			col('location', 'Location'), col('is_active', 'Active', 'bool'),
		],
		searchFields: ['equipment_code', 'equipment_name'],
		filters: [enumFilter('equipment_type', 'Type'), relFilter('facility_id', 'Facility', 'facilities', 'name'), boolFilter('is_active', 'Active')],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'materials', collection: 'materials', title: 'Materials', group: 'resources', primaryKey: 'material_id',
		columns: [
			col('alloy_code', 'Alloy', 'code'), col('common_name', 'Name'),
			rel('iso_code', 'ISO class', 'material_iso_classifications', 'iso_code'),
			col('density_g_per_cm3', 'Density (g/cm³)', 'number'),
			col('export_controlled', 'Export controlled', 'bool'),
		],
		searchFields: ['alloy_code', 'common_name'],
		filters: [relFilter('iso_code', 'ISO class', 'material_iso_classifications', 'iso_code'), boolFilter('export_controlled', 'Export controlled')],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'machine-operators', collection: 'Machine_Operators', title: 'Machine operators', group: 'resources', primaryKey: 'id',
		columns: [col('Name', 'Name'), col('equipment', 'Equipment')],
		searchFields: ['Name'],
		filters: [],
		defaultSort: 'Name', rowTarget: 'drawer',
	},
	{
		slug: 'insert-types', collection: 'insert_types', title: 'Insert types', group: 'resources', primaryKey: 'insert_type_id',
		columns: [
			col('type_code', 'Type code', 'code'), col('short_code', 'Short code', 'code'),
			rel('manufacturer_id', 'Manufacturer', 'manufacturers', 'name'),
			col('iso_designation', 'ISO designation'), col('coating', 'Coating'), col('edge_count', 'Edges', 'number'),
		],
		searchFields: ['type_code', 'short_code', 'iso_designation'],
		filters: [relFilter('manufacturer_id', 'Manufacturer', 'manufacturers', 'name'), enumFilter('op_type', 'Op type')],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'iso-classes', collection: 'material_iso_classifications', title: 'ISO classes', group: 'resources', primaryKey: 'iso_code',
		columns: [col('iso_code', 'ISO code', 'code'), col('description', 'Description')],
		searchFields: ['iso_code', 'description'],
		filters: [],
		defaultSort: 'iso_code', rowTarget: 'drawer',
	},
	{
		slug: 'methods', collection: 'manufacturing_methods', title: 'Methods', group: 'resources', primaryKey: 'method_id',
		columns: [col('method_code', 'Code', 'code'), col('method_name', 'Name'), col('process_category', 'Process category')],
		searchFields: ['method_code', 'method_name'],
		filters: [processCategory],
		defaultSort: 'method_code', rowTarget: 'drawer',
	},
	{
		slug: 'manufacturers', collection: 'manufacturers', title: 'Manufacturers', group: 'resources', primaryKey: 'manufacturer_id',
		columns: [col('name', 'Name')],
		searchFields: ['name'],
		filters: [],
		defaultSort: 'name', rowTarget: 'drawer',
	},
	{
		slug: 'facilities', collection: 'facilities', title: 'Facilities', group: 'resources', primaryKey: 'facility_id',
		columns: [col('code', 'Code', 'code'), col('name', 'Name')],
		searchFields: ['code', 'name'],
		filters: [],
		defaultSort: 'code', rowTarget: 'drawer',
	},
	{
		slug: 'prep-recipes', collection: 'prep_recipes', title: 'Prep recipes', group: 'resources', primaryKey: 'recipe_id',
		columns: [col('name', 'Name'), col('suited_materials', 'Suited materials'), col('created_at', 'Created', 'date')],
		searchFields: ['name'],
		filters: [],
		defaultSort: '-created_at', rowTarget: 'drawer',
	},
	{
		slug: 'etchants', collection: 'etchants', title: 'Etchants', group: 'resources', primaryKey: 'etchant_id',
		columns: [col('name', 'Name'), col('composition', 'Composition'), col('suited_metals', 'Suited metals')],
		searchFields: ['name', 'composition'],
		filters: [],
		defaultSort: 'name', rowTarget: 'drawer',
	},
	{
		slug: 'fast-recipes', collection: 'fast_recipes', title: 'FAST recipes', group: 'resources', primaryKey: 'id',
		columns: [
			col('name', 'Name'), col('machine', 'Machine'), col('program_nr', 'Program', 'number'), col('group_name', 'Group'),
			col('target_temp_c', 'Temp (°C)', 'number'), col('target_force_kn', 'Force (kN)', 'number'),
			col('hold_time_min', 'Hold (min)', 'number'), col('date_changed', 'Changed', 'date'),
		],
		searchFields: ['name', 'machine', 'group_name'],
		filters: [enumFilter('machine', 'Machine'), enumFilter('group_name', 'Group')],
		defaultSort: '-date_changed', rowTarget: 'drawer',
	},
];

export function indexDefBySlug(slug: string): IndexDef | undefined {
	return INDEX_DEFS.find((d) => d.slug === slug);
}

export function indexDefByCollection(collection: string): IndexDef | undefined {
	return INDEX_DEFS.find((d) => d.collection === collection);
}
