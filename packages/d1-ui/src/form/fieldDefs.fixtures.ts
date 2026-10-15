// Field definitions as GET /fields/<collection> returns them, for the form's tests. The metadata is copied from
// the real rows: scripts/configure_directus.sql and configure_inline_params.sql (interface, options, special),
// then migrations 20261014000173 / 174 / 175 (groups, sorts, labels, notes, required, conditions, choices).
// Only a handful of the ~300 rows, chosen so every kind and every condition shape is covered.
import type { FieldDef } from './fieldModel';

const en = (translation: string) => [{ language: 'en-US', translation }];
const hideUnless = (field: string, value: string, label = value) => [
	{ name: `Hide unless ${label}`, rule: { _and: [{ [field]: { _neq: value } }] }, hidden: true },
];
const showWhen = (field: string, value: string) => [
	{ name: `show when ${value}`, rule: { _and: [{ [field]: { _eq: value } }] }, hidden: false, readonly: false, required: false },
];

interface Spec {
	type?: string;
	special?: string[] | null;
	interface?: string | null;
	options?: Record<string, unknown> | null;
	hidden?: boolean;
	readonly?: boolean;
	required?: boolean;
	sort?: number | null;
	width?: string;
	label?: string;
	note?: string | null;
	conditions?: unknown[] | null;
	group?: string | null;
	fk?: string;
	fkKey?: string;
	pk?: boolean;
	/** schema.default_value */
	default?: unknown;
}

function def(collection: string, field: string, s: Spec = {}): FieldDef {
	return {
		collection,
		field,
		type: s.type ?? 'string',
		schema: {
			name: field,
			table: collection,
			data_type: s.type === 'decimal' ? 'numeric' : (s.type ?? 'text'),
			is_nullable: true,
			is_primary_key: !!s.pk,
			default_value: s.default ?? null,
			...(s.fk ? { foreign_key_table: s.fk, foreign_key_column: s.fkKey ?? 'id' } : {}),
		},
		meta: {
			collection,
			field,
			special: s.special ?? null,
			interface: s.interface === undefined ? 'input' : s.interface,
			options: s.options ?? null,
			hidden: s.hidden ?? false,
			readonly: s.readonly ?? false,
			required: s.required ?? false,
			sort: s.sort === undefined ? null : s.sort,
			width: s.width ?? 'half',
			translations: s.label ? en(s.label) : null,
			note: s.note ?? null,
			conditions: s.conditions ?? null,
			group: s.group ?? null,
		},
	};
}

const group = (collection: string, field: string, label: string, sort: number, start: 'open' | 'closed', conditions: unknown[] | null = null, parent: string | null = null) =>
	def(collection, field, {
		type: 'alias',
		special: ['alias', 'no-data', 'group'],
		interface: 'group-detail',
		options: { start },
		sort,
		width: 'full',
		label,
		conditions,
		group: parent,
	});

const HIDE_UNTIL_SAVED = [{ name: 'Hide until saved once', rule: { _and: [{ short_id: { _empty: true } }] }, hidden: true }];
const RIG_KIT = { _and: [{ item_type: { _in: ['equipment', 'miscellaneous'] } }] };
const HIDE_FOR_RIG_KIT = [{ name: 'Hide for rig kit', rule: RIG_KIT, hidden: true }];

const FORM_CHOICES = [
	{ text: 'Disc', value: 'disc' },
	{ text: 'Ring', value: 'ring' },
	{ text: 'Cylinder', value: 'cylinder' },
	{ text: 'Block', value: 'block' },
	{ text: 'Tensile coupon (ISO 6892)', value: 'tensile_coupon' },
];

// physical_samples (Samples) -------------------------------------------------------------------------
export const SAMPLE_DEFS: FieldDef[] = [
	// not in form order on purpose: the model sorts
	def('physical_samples', 'diameter_mm', {
		type: 'decimal',
		options: { step: 0.001, suffix: 'mm' },
		group: 'grp_geometry',
		sort: 30,
		label: 'Diameter Ø',
		note: 'Outer diameter, across the x and y axes.',
		conditions: [
			{ name: 'sample only', rule: RIG_KIT, hidden: true, readonly: false, required: false },
			{ name: 'form', rule: { _and: [{ form: { _nin: ['disc', 'ring', 'cylinder', 'round_bar'] } }] }, hidden: true, readonly: false, required: false },
		],
	}),
	group('physical_samples', 'grp_geometry', 'Geometry', 30, 'open', HIDE_FOR_RIG_KIT),
	def('physical_samples', 'form', {
		interface: 'select-dropdown',
		options: { choices: FORM_CHOICES, allowOther: true },
		group: 'grp_material',
		sort: 10,
		label: 'Geometry',
		required: true,
		conditions: [{ name: 'sample only', rule: RIG_KIT, hidden: true }],
	}),
	group('physical_samples', 'grp_material', 'Material & origin', 20, 'open', HIDE_FOR_RIG_KIT),
	def('physical_samples', 'material_id', {
		type: 'uuid',
		special: ['m2o'],
		interface: 'select-dropdown-m2o',
		options: { template: '{{common_name}} ({{alloy_code}})' },
		fk: 'materials',
		fkKey: 'material_id',
		group: 'grp_material',
		sort: 20,
		label: 'Material',
		required: true,
	}),
	def('physical_samples', 'sample_id', { type: 'uuid', special: ['uuid'], hidden: true, readonly: true, sort: 1, width: 'full', pk: true }),
	def('physical_samples', 'sample_code', { interface: 'd1-sample-code', group: 'grp_what', sort: 10, label: 'Sample Code' }),
	def('physical_samples', 'nickname', { group: 'grp_what', sort: 20, label: 'Nickname' }),
	group('physical_samples', 'grp_what', 'What', 10, 'open'),
	def('physical_samples', 'current_status', {
		interface: 'select-dropdown',
		options: { choices: [{ text: 'Active', value: 'active' }, { text: 'Consumed', value: 'consumed' }, { text: 'Destroyed', value: 'destroyed' }, { text: 'Archived', value: 'archived' }] },
		group: 'grp_what',
		sort: 30,
		label: 'Status',
	}),
	def('physical_samples', 'item_type', {
		interface: 'select-dropdown',
		options: { choices: [{ text: 'Sample', value: 'sample' }, { text: 'Equipment', value: 'equipment' }, { text: 'Miscellaneous', value: 'miscellaneous' }] },
		hidden: true,
		sort: 5,
		default: 'sample',
	}),
	def('physical_samples', 'mounted', { type: 'boolean', interface: 'toggle', special: ['cast-boolean'], group: 'grp_surface', sort: 20, label: 'Mounted?' }),
	group('physical_samples', 'grp_surface', 'Surface & mounting', 40, 'open', HIDE_FOR_RIG_KIT),
	def('physical_samples', 'manufactured_date', { type: 'date', interface: 'datetime', options: { type: 'date' }, group: 'grp_material', sort: 40, label: 'Manufacturing Date' }),
	def('physical_samples', 'owner_person_id', {
		type: 'uuid',
		special: ['m2o'],
		interface: 'select-dropdown-m2o',
		options: { template: '{{full_name}}', enableCreate: false },
		fk: 'people',
		fkKey: 'person_id',
		group: 'grp_who_where',
		sort: 10,
		label: 'Owner',
	}),
	group('physical_samples', 'grp_who_where', 'Who & where', 50, 'open'),
	def('physical_samples', 'notes', { type: 'text', interface: 'input-multiline', width: 'full', group: 'grp_notes', sort: 10, label: 'Notes' }),
	group('physical_samples', 'grp_notes', 'Notes', 60, 'open'),
	def('physical_samples', 'co_owners', { type: 'alias', special: ['m2m'], interface: 'list-m2m', group: 'grp_who_where', sort: 30, width: 'full', note: 'Members share a sample through Who has access in STARbase.' }),
	def('physical_samples', 'campaigns', { type: 'alias', special: ['o2m'], interface: 'list-o2m', group: 'grp_related', sort: 10, width: 'full' }),
	group('physical_samples', 'grp_related', 'Related records', 70, 'closed', HIDE_UNTIL_SAVED),
	def('physical_samples', 'short_id', { group: 'grp_legacy', sort: 10, readonly: true, default: '' }),
	def('physical_samples', 'created_at', { type: 'timestamp', special: ['date-created'], interface: 'datetime', readonly: true, hidden: true }),
	def('physical_samples', 'report_button', { type: 'alias', special: ['alias', 'no-data'], interface: 'd1-report-button', sort: 0, width: 'full' }),
	group('physical_samples', 'grp_legacy', 'Legacy / system', 80, 'closed'),
];

// manufacturing_operations (Operations) --------------------------------------------------------------
const OP_PARAM = (field: string, sort: number, label: string, suffix: string, grp: string, when: string) =>
	def('manufacturing_operations', field, { type: 'decimal', options: { step: 0.5, suffix }, group: grp, sort, label, hidden: true, conditions: showWhen('process_category', when) });

export const OPERATION_DEFS: FieldDef[] = [
	group('manufacturing_operations', 'grp_what', 'What', 10, 'open'),
	def('manufacturing_operations', 'method_id', {
		type: 'uuid',
		special: ['m2o'],
		interface: 'select-dropdown-m2o',
		options: { template: '{{method_code}} – {{method_name}}' },
		fk: 'manufacturing_methods',
		fkKey: 'method_id',
		group: 'grp_what',
		sort: 10,
		label: 'Method',
		required: true,
	}),
	def('manufacturing_operations', 'process_category', { interface: 'd1-process-category', group: 'grp_what', sort: 20, label: 'Process Category' }),
	def('manufacturing_operations', 'sample_id', {
		type: 'uuid',
		special: ['m2o'],
		interface: 'select-dropdown-m2o',
		options: { template: '{{sample_code}} – {{nickname}}', enableCreate: true },
		fk: 'physical_samples',
		fkKey: 'sample_id',
		group: 'grp_what',
		sort: 30,
		label: 'Input sample',
		conditions: [{ name: 'machining needs an input sample', rule: { _and: [{ process_category: { _eq: 'machining' } }] }, hidden: false, readonly: false, required: true }],
	}),
	def('manufacturing_operations', 'operation_date', {
		type: 'timestamp',
		interface: 'datetime',
		group: 'grp_what',
		sort: 50,
		label: 'Date',
		required: true,
	}),
	def('manufacturing_operations', 'machining_operation_subtype', {
		interface: 'select-dropdown',
		options: { choices: [{ text: 'Turning – Facing', value: 'MT-F' }, { text: 'Turning – Roughing', value: 'MT-R' }, { text: 'Milling – Facing', value: 'MM-F' }] },
		group: 'grp_what',
		sort: 60,
		label: 'Machining Operation Subtype',
		hidden: true, conditions: showWhen('process_category', 'machining'),
	}),
	def('manufacturing_operations', 'pass_code', { interface: 'd1-operation-code', options: {}, width: 'full', group: 'grp_what', sort: 70, label: 'Operation Code' }),
	group('manufacturing_operations', 'grp_tooling', 'Tooling', 30, 'open', hideUnless('process_category', 'machining', 'machining')),
	def('manufacturing_operations', 'tool_id', {
		type: 'uuid',
		special: ['m2o'],
		interface: 'select-dropdown-m2o',
		options: { template: '{{tool_code}} – {{tool_name}}' },
		fk: 'tools',
		fkKey: 'tool_id',
		group: 'grp_tooling',
		sort: 10,
		label: 'Tool',
	}),
	group('manufacturing_operations', 'grp_cutting', 'Cutting parameters', 40, 'open', hideUnless('process_category', 'machining')),
	OP_PARAM('machining_spindle_speed_rpm', 20, 'Spindle Speed', 'rpm', 'grp_cutting', 'machining'),
	def('manufacturing_operations', 'machining_coolant_used', { type: 'boolean', interface: 'toggle', group: 'grp_cutting', sort: 90, label: 'Coolant Used?', hidden: true, conditions: showWhen('process_category', 'machining') }),
	group('manufacturing_operations', 'grp_sintering', 'Sintering', 60, 'open', hideUnless('process_category', 'sintering')),
	group('manufacturing_operations', 'sintering_machine_group', 'Machine data', 10, 'open', null, 'grp_sintering'),
	OP_PARAM('sintering_max_temp_celsius', 90, 'Max Temp', '°C', 'sintering_machine_group', 'sintering'),
	def('manufacturing_operations', 'sintering_run_number', { type: 'integer', options: { step: 1 }, group: 'sintering_machine_group', sort: 10, label: 'Run Number', hidden: true, conditions: showWhen('process_category', 'sintering') }),
	def('manufacturing_operations', 'outcome_notes', { type: 'text', interface: 'input-multiline', width: 'full', group: 'grp_notes_files', sort: 10, label: 'Notes' }),
	group('manufacturing_operations', 'grp_notes_files', 'Notes & files', 110, 'open'),
	def('manufacturing_operations', 'nc_program_text', {
		type: 'text',
		interface: 'input-code',
		hidden: true,
		width: 'full',
		group: 'grp_legacy',
		sort: 80,
		conditions: [{ name: 'show when it has a value', rule: { _and: [{ nc_program_text: { _nempty: true } }] }, hidden: false, readonly: false, required: false }],
	}),
	group('manufacturing_operations', 'grp_legacy', 'Legacy / system', 130, 'closed'),
	def('manufacturing_operations', 'data_file_links', { type: 'json', special: ['cast-json'], interface: 'input-code', width: 'full', group: 'grp_notes_files', sort: 20 }),
	def('manufacturing_operations', 'orphaned_field', { group: 'grp_removed_group', sort: 5, label: 'Orphan' }),
];

// test_sessions (Tests) ------------------------------------------------------------------------------
export const TEST_DEFS: FieldDef[] = [
	group('test_sessions', 'grp_what', 'What', 10, 'open'),
	def('test_sessions', 'test_type', {
		interface: 'select-dropdown',
		options: { choices: [{ text: 'Tensile', value: 'tensile' }, { text: 'Hardness', value: 'hardness' }, { text: 'SEM', value: 'sem' }] },
		group: 'grp_what',
		sort: 10,
		label: 'Test Type',
		required: true,
	}),
	def('test_sessions', 'session_date', { type: 'timestamp', interface: 'datetime', group: 'grp_what', sort: 40, label: 'Session Date', required: true }),
	group('test_sessions', 'grp_tensile_params', 'Tensile parameters', 30, 'open', hideUnless('test_type', 'tensile')),
	def('test_sessions', 'tensile_gauge_length_mm', {
		type: 'decimal',
		options: { step: 0.01, suffix: 'mm' },
		group: 'grp_tensile_params',
		sort: 20,
		label: 'Gauge Length',
		hidden: true, conditions: showWhen('test_type', 'tensile'),
	}),
	def('test_sessions', 'tensile_extensometer_used', { type: 'boolean', interface: 'toggle', group: 'grp_tensile_params', sort: 90, label: 'Extensometer used?', hidden: true, conditions: showWhen('test_type', 'tensile') }),
	group('test_sessions', 'grp_tensile_results', 'Tensile results', 40, 'open', hideUnless('test_type', 'tensile')),
	def('test_sessions', 'tensile_uts_mpa', { type: 'decimal', options: { step: 0.1, suffix: 'MPa' }, group: 'grp_tensile_results', sort: 20, label: 'UTS', hidden: true, conditions: showWhen('test_type', 'tensile') }),
];
