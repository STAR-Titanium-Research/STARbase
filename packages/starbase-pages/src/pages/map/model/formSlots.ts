// Inside-tray slots and key settings of a container (spec D6, D7, §6.4). Pure: no Vue, no I/O.
//
// `formSlots` turns the relations of one operation or test into slots (majors first), `keySettings`
// picks at most four inline parameters for its process category, and `mergeSlots` / `mergeSettings`
// fold the rows of a batch into one set: a value every row shares appears once, differing values
// become one entry with `values` ("N different") or the value "varies".

import type { OpRow, ProcessCategory, Ref, Slot, TestRow } from './types';

export type { Slot };

export interface RelationDef {
  field: string;
  label: string;
  collection: string;
}

type Kind = 'operation' | 'test';

/** The relations of the form, spec §4, used when the field/relation calls are refused. */
export const FALLBACK_RELATIONS: Record<Kind, RelationDef[]> = {
  operation: [
    { field: 'method_id', label: 'Method', collection: 'manufacturing_methods' },
    { field: 'project_id', label: 'Project', collection: 'projects' },
    { field: 'campaign_id', label: 'Campaign', collection: 'campaigns' },
    { field: 'equipment_id', label: 'Machine', collection: 'equipment' },
    { field: 'tool_id', label: 'Tool', collection: 'tools' },
    { field: 'insert_edge_id', label: 'Insert edge', collection: 'insert_edges' },
    { field: 'material_id', label: 'Material', collection: 'materials' },
    { field: 'source_recipe_id', label: 'Prep recipe', collection: 'prep_recipes' },
    { field: 'fast_recipe_id', label: 'FAST recipe', collection: 'fast_recipes' },
    { field: 'operator', label: 'Operator', collection: 'directus_users' },
    { field: 'operator_person_id', label: 'Operator', collection: 'people' },
    { field: 'owner_person_id', label: 'Owner', collection: 'people' },
    { field: 'gcode_file', label: 'G-code file', collection: 'directus_files' },
    { field: 'force_file_id', label: 'Force data', collection: 'directus_files' },
  ],
  test: [
    { field: 'equipment_id', label: 'Machine', collection: 'equipment' },
    { field: 'insert_edge_id', label: 'Insert edge', collection: 'insert_edges' },
    { field: 'project_id', label: 'Project', collection: 'projects' },
    { field: 'campaign_id', label: 'Campaign', collection: 'campaigns' },
    { field: 'operator_person_id', label: 'Operator', collection: 'people' },
    { field: 'owner_person_id', label: 'Owner', collection: 'people' },
    { field: 'session_data_files', label: 'Data files', collection: 'directus_files' },
  ],
};

/** Major fields in display order, with the role each one is shown under (spec D6). */
const MAJOR: Record<Kind, { field: string; role: string }[]> = {
  operation: [
    { field: 'equipment_id', role: 'Machine' },
    { field: 'tool_id', role: 'Tool' },
    { field: 'insert_edge_id', role: 'Insert edge' },
    { field: 'fast_recipe_id', role: 'Recipe' },
    { field: 'source_recipe_id', role: 'Recipe' },
    { field: 'force_file_id', role: 'Force data' },
  ],
  test: [
    { field: 'equipment_id', role: 'Machine' },
    { field: 'insert_edge_id', role: 'Insert edge' },
    { field: 'session_data_files', role: 'Data' },
  ],
};

/** Shown elsewhere on the container (input/output rows, header, project frame): never a slot. */
const EXCLUDED = new Set(['sample_id', 'output_sample_id', 'method_id', 'project_id', 'batch_id']);

export function formSlots(row: OpRow | TestRow, kind: Kind, defs: RelationDef[]): Slot[] {
  const refOf = (field: string): Ref | null => row.relations[field] ?? null;

  const slots: Slot[] = [];
  // A major relation on the row always shows, even if the runtime `defs` do not list it.
  for (const major of MAJOR[kind]) {
    const ref = refOf(major.field);
    if (ref) slots.push({ field: major.field, role: major.role, ref, major: true });
  }
  const majors = new Set(MAJOR[kind].map((m) => m.field));
  for (const def of defs) {
    if (EXCLUDED.has(def.field) || majors.has(def.field)) continue;
    const ref = refOf(def.field);
    if (ref) slots.push({ field: def.field, role: def.label, ref, major: false });
  }
  return slots;
}

// ---- key settings (spec §6.4) --------------------------------------------------------------

interface SettingField {
  /** Field name in `row.settings`; `test_type` is read from `TestRow.testType`. */
  field: string;
  /** Unit written after a number. */
  unit?: string;
}
interface SettingDef {
  label: string;
  /** First field that has a value wins. */
  fields: SettingField[];
}

/**
 * The §6.4 labels mapped to inline parameter fields of `manufacturing_operations` / `test_sessions`
 * (field names and units from db/migrations/20261009000143_restore_inline_param_field_meta.sql).
 *
 * Dropped because no such field exists: sintering "dwell"; sample_prep "steps / final abrasive",
 * "force", "time" (prep steps are an o2m alias, `prep_steps`, not an inline field); additive
 * "build plate"; deformation "strain" and "force". `machining_axial_depth_of_cut_mm` stands for
 * "depth of cut". Tests: "headline result" is the first present of the main result fields; "standard"
 * is `charpy_specimen_standard`, else `tribology_test_standard` (migration 20260703000058).
 */
export const KEY_SETTING_FIELDS: Record<NonNullable<ProcessCategory> | 'test', SettingDef[]> = {
  sintering: [
    { label: 'Max temperature', fields: [{ field: 'sintering_max_temp_celsius', unit: '°C' }] },
    { label: 'Max force', fields: [{ field: 'sintering_max_force_kn', unit: 'kN' }] },
    { label: 'Mould diameter', fields: [{ field: 'sintering_mould_diameter_mm', unit: 'mm' }] },
  ],
  machining: [
    { label: 'Cutting speed', fields: [{ field: 'machining_cutting_speed_m_per_min', unit: 'm/min' }] },
    { label: 'Feed', fields: [{ field: 'machining_feed_mm_per_rev', unit: 'mm/rev' }] },
    { label: 'Depth of cut', fields: [{ field: 'machining_axial_depth_of_cut_mm', unit: 'mm' }] },
    { label: 'Coolant', fields: [{ field: 'machining_coolant_used' }] },
  ],
  sample_prep: [],
  heat_treatment: [
    { label: 'Temperature', fields: [{ field: 'ht_peak_temp_celsius', unit: '°C' }] },
    { label: 'Time', fields: [{ field: 'ht_hold_time_min', unit: 'min' }] },
    { label: 'Atmosphere', fields: [{ field: 'ht_atmosphere' }] },
    { label: 'Cooling', fields: [{ field: 'ht_cooling_method' }] },
  ],
  additive: [
    { label: 'Layer thickness', fields: [{ field: 'am_layer_thickness_mm', unit: 'mm' }] },
    { label: 'Power', fields: [{ field: 'am_laser_power_w', unit: 'W' }] },
    { label: 'Scan speed', fields: [{ field: 'am_scan_speed_mm_per_s', unit: 'mm/s' }] },
  ],
  deformation: [
    { label: 'Temperature', fields: [{ field: 'deform_deformation_temp_celsius', unit: '°C' }] },
    { label: 'Strain rate', fields: [{ field: 'deform_strain_rate_per_sec', unit: 's⁻¹' }] },
  ],
  test: [
    { label: 'Test type', fields: [{ field: 'test_type' }] },
    {
      label: 'Standard',
      fields: [{ field: 'charpy_specimen_standard' }, { field: 'tribology_test_standard' }],
    },
    {
      label: 'Result',
      fields: [
        { field: 'tensile_uts_mpa', unit: 'MPa' },
        { field: 'compression_yield_strength_mpa', unit: 'MPa' },
        { field: 'hardness_mean_hardness' },
        { field: 'charpy_absorbed_energy_j', unit: 'J' },
        { field: 'tribology_coefficient_of_friction' },
      ],
    },
  ],
};

const MAX_SETTINGS = 4;

/** Shows a value the way the form would; null for "nothing to show". */
function formatValue(value: unknown, unit: string | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  let n: number | null = null;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) n = Number(value);
  if (n !== null) {
    if (!Number.isFinite(n)) return null;
    // 4 significant figures below 1000 (0.0004 stays 0.0004), tenths from 1000 up; never an exponent.
    const text =
      Math.abs(n) >= 1000
        ? n.toLocaleString('en-GB', { maximumFractionDigits: 1, useGrouping: false })
        : n.toLocaleString('en-GB', { maximumSignificantDigits: 4, useGrouping: false });
    return unit ? `${text} ${unit}` : text;
  }
  if (typeof value === 'string') return value.trim() || null;
  return null;
}

export function keySettings(
  row: OpRow | TestRow,
  category: ProcessCategory | 'test',
): { label: string; value: string }[] {
  const source: Record<string, unknown> = { ...row.settings };
  if ('testType' in row) source.test_type = row.testType;

  const out: { label: string; value: string }[] = [];
  for (const def of category ? KEY_SETTING_FIELDS[category] : []) {
    for (const { field, unit } of def.fields) {
      const value = formatValue(source[field], unit);
      if (value === null) continue;
      out.push({ label: def.label, value });
      break;
    }
    if (out.length === MAX_SETTINGS) break;
  }
  return out;
}

// ---- batches: one set from many rows (spec §5.3 last paragraph) ------------------------------

const refKey = (ref: Ref) => `${ref.collection}:${ref.id}`;

/**
 * One slot per field, in first-seen order. A slot every row has with the same record stays as it is;
 * otherwise `ref` is null and `values` holds each distinct record once; `partial` is also set when
 * some rows have no such slot at all.
 */
export function mergeSlots(rows: Slot[][]): Slot[] {
  if (rows.length === 0) return [];
  const fields: string[] = [];
  for (const row of rows) for (const s of row) if (!fields.includes(s.field)) fields.push(s.field);

  return fields.map((field) => {
    const perRow = rows.map((row) => row.find((s) => s.field === field));
    const first = perRow.find((s): s is Slot => !!s)!;
    const refs = perRow.map((s) => s?.ref ?? null);
    const distinct = new Map<string, Ref>();
    for (const ref of refs) if (ref) distinct.set(refKey(ref), ref);

    const shared = refs.every((ref) => ref !== null) && distinct.size === 1;
    if (shared || distinct.size === 0) {
      return { field, role: first.role, ref: refs.find((r) => r) ?? null, major: first.major };
    }
    const merged: Slot = { field, role: first.role, ref: null, major: first.major, values: [...distinct.values()] };
    if (refs.some((ref) => ref === null)) merged.partial = true;
    return merged;
  });
}

/** One setting per label, in first-seen order; "varies" when rows differ or only some have it. */
export function mergeSettings(rows: { label: string; value: string }[][]): { label: string; value: string }[] {
  if (rows.length === 0) return [];
  const labels: string[] = [];
  for (const row of rows) for (const s of row) if (!labels.includes(s.label)) labels.push(s.label);

  return labels.slice(0, MAX_SETTINGS).map((label) => {
    const values = rows.map((row) => row.find((s) => s.label === label)?.value);
    const first = values[0];
    return { label, value: first !== undefined && values.every((v) => v === first) ? first : 'varies' };
  });
}
