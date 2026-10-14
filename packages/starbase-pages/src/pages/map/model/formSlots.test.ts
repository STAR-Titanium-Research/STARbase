import { describe, expect, it } from 'vitest';
import { FALLBACK_RELATIONS, formSlots, keySettings, mergeSettings, mergeSlots } from './formSlots';
import { mkOp, mkTest } from './fixtures';
import type { Ref, Slot } from './types';

const ref = (collection: string, id: string): Ref => ({ collection, id, code: id.toUpperCase() });
const slot = (field: string, role: string, r: Ref | null, major = true): Slot => ({ field, role, ref: r, major });

describe('formSlots', () => {
  it('puts majors first in the order above', () => {
    const op = mkOp({
      relations: {
        material_id: ref('materials', 'm1'),
        force_file_id: ref('directus_files', 'f1'),
        source_recipe_id: ref('prep_recipes', 'r1'),
        insert_edge_id: ref('insert_edges', 'ie1'),
        tool_id: ref('tools', 't1'),
        equipment_id: ref('equipment', 'e1'),
        fast_recipe_id: ref('fast_recipes', 'fr1'),
      },
    });
    const slots = formSlots(op, 'operation', FALLBACK_RELATIONS.operation);
    expect(slots.map((s) => s.field)).toEqual([
      'equipment_id',
      'tool_id',
      'insert_edge_id',
      'fast_recipe_id',
      'source_recipe_id',
      'force_file_id',
      'material_id',
    ]);
    expect(slots.map((s) => s.role)).toEqual([
      'Machine',
      'Tool',
      'Insert edge',
      'Recipe',
      'Recipe',
      'Force data',
      'Material',
    ]);
    expect(slots.map((s) => s.major)).toEqual([true, true, true, true, true, true, false]);
  });

  it('test majors are machine, insert edge, data', () => {
    const test = mkTest({
      relations: {
        session_data_files: ref('directus_files', 'd1'),
        campaign_id: ref('campaigns', 'c1'),
        equipment_id: ref('equipment', 'e1'),
      },
    });
    const slots = formSlots(test, 'test', FALLBACK_RELATIONS.test);
    expect(slots.map((s) => [s.field, s.role, s.major])).toEqual([
      ['equipment_id', 'Machine', true],
      ['session_data_files', 'Data', true],
      ['campaign_id', 'Campaign', false],
    ]);
  });

  it('unknown relation from defs becomes a folded slot with its label', () => {
    const op = mkOp({ relations: { furnace_liner_id: ref('liners', 'l1') } });
    const defs = [
      ...FALLBACK_RELATIONS.operation,
      { field: 'furnace_liner_id', label: 'Furnace liner', collection: 'liners' },
    ];
    expect(formSlots(op, 'operation', defs)).toEqual([
      { field: 'furnace_liner_id', role: 'Furnace liner', ref: ref('liners', 'l1'), major: false },
    ]);
  });

  it('empty relation → no slot', () => {
    const op = mkOp({ relations: { equipment_id: null, tool_id: ref('tools', 't1') } });
    expect(formSlots(op, 'operation', FALLBACK_RELATIONS.operation).map((s) => s.field)).toEqual(['tool_id']);
  });

  it('excluded fields never appear', () => {
    const r = ref('x', '1');
    const op = mkOp({
      relations: { sample_id: r, output_sample_id: r, method_id: r, project_id: r, batch_id: r, tool_id: r },
    });
    const defs = ['sample_id', 'output_sample_id', 'method_id', 'project_id', 'batch_id', 'tool_id'].map((field) => ({
      field,
      label: field,
      collection: 'x',
    }));
    expect(formSlots(op, 'operation', defs).map((s) => s.field)).toEqual(['tool_id']);
  });
});

describe('keySettings', () => {
  it('sintering returns max temp, max force, mould in that order and skips a missing one', () => {
    const op = mkOp({
      category: 'sintering',
      settings: { sintering_mould_diameter_mm: '30.000', sintering_max_temp_celsius: 1200, sintering_max_force_kn: 50.5 },
    });
    expect(keySettings(op, 'sintering')).toEqual([
      { label: 'Max temperature', value: '1200 °C' },
      { label: 'Max force', value: '50.5 kN' },
      { label: 'Mould diameter', value: '30 mm' },
    ]);
    const noForce = mkOp({ settings: { sintering_max_temp_celsius: 900, sintering_mould_diameter_mm: 20 } });
    expect(keySettings(noForce, 'sintering').map((s) => s.label)).toEqual(['Max temperature', 'Mould diameter']);
  });

  it('caps at 4', () => {
    const op = mkOp({
      settings: {
        machining_cutting_speed_m_per_min: 100,
        machining_feed_mm_per_rev: 0.1,
        machining_axial_depth_of_cut_mm: 1,
        machining_coolant_used: true,
        machining_radial_depth_of_cut_mm: 2,
      },
    });
    const list = keySettings(op, 'machining');
    expect(list).toHaveLength(4);
    expect(list[3]).toEqual({ label: 'Coolant', value: 'Yes' });
  });

  it('skips empty values but shows false', () => {
    const op = mkOp({
      settings: { ht_peak_temp_celsius: null, ht_hold_time_min: '', ht_atmosphere: ' argon ', ht_cooling_method: undefined },
    });
    expect(keySettings(op, 'heat_treatment')).toEqual([{ label: 'Atmosphere', value: 'argon' }]);
    expect(keySettings(mkOp({ settings: { machining_coolant_used: false } }), 'machining')).toEqual([
      { label: 'Coolant', value: 'No' },
    ]);
  });

  it('categories with no matching field give nothing, a null category too', () => {
    expect(keySettings(mkOp({ settings: { x: 1 } }), 'sample_prep')).toEqual([]);
    expect(keySettings(mkOp({ settings: { sintering_max_force_kn: 1 } }), null)).toEqual([]);
  });

  it('tests: type, standard, headline result', () => {
    const t = mkTest({ testType: 'Tensile', settings: { tensile_uts_mpa: '950.5', charpy_specimen_standard: 'ASTM E23' } });
    expect(keySettings(t, 'test')).toEqual([
      { label: 'Test type', value: 'Tensile' },
      { label: 'Standard', value: 'ASTM E23' },
      { label: 'Result', value: '950.5 MPa' },
    ]);
  });
});

describe('mergeSlots', () => {
  const machine = ref('equipment', 'e1');

  it('keeps a shared machine once and turns 2 different tools into one entry with 2 values', () => {
    const merged = mergeSlots([
      [slot('equipment_id', 'Machine', machine), slot('tool_id', 'Tool', ref('tools', 't1'))],
      [slot('equipment_id', 'Machine', machine), slot('tool_id', 'Tool', ref('tools', 't2'))],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ field: 'equipment_id', role: 'Machine', ref: machine, major: true });
    expect(merged[1]).toMatchObject({ field: 'tool_id', ref: null });
    expect(merged[1].values?.map((v) => v.id)).toEqual(['t1', 't2']);
  });

  it('the same tool twice stays one; a slot only some rows have becomes values', () => {
    const t = ref('tools', 't1');
    expect(mergeSlots([[slot('tool_id', 'Tool', t)], [slot('tool_id', 'Tool', { ...t })]])[0].values).toBeUndefined();
    expect(mergeSlots([[slot('tool_id', 'Tool', t)], [slot('tool_id', 'Tool', t)], []])).toEqual([
      { field: 'tool_id', role: 'Tool', ref: null, major: true, values: [t] },
    ]);
  });

  it('a single row is unchanged and no rows give nothing', () => {
    const only = [slot('equipment_id', 'Machine', machine)];
    expect(mergeSlots([only])).toEqual(only);
    expect(mergeSlots([])).toEqual([]);
  });
});

describe('mergeSettings', () => {
  it('gives varies for differing values', () => {
    expect(
      mergeSettings([
        [
          { label: 'Feed', value: '0.1 mm/rev' },
          { label: 'Cutting speed', value: '100 m/min' },
        ],
        [
          { label: 'Feed', value: '0.2 mm/rev' },
          { label: 'Cutting speed', value: '100 m/min' },
        ],
      ]),
    ).toEqual([
      { label: 'Feed', value: 'varies' },
      { label: 'Cutting speed', value: '100 m/min' },
    ]);
  });

  it('varies when only some rows have the setting, and caps at 4', () => {
    expect(mergeSettings([[{ label: 'A', value: '1' }], []])).toEqual([{ label: 'A', value: 'varies' }]);
    const many = ['A', 'B', 'C', 'D'].map((label) => ({ label, value: '1' }));
    expect(mergeSettings([many, [...many, { label: 'E', value: '2' }]])).toHaveLength(4);
  });
});
