// The words people read for the stored values of four dropdowns: Geometry (physical_samples.form), Surface
// Finish (physical_samples.surface_finish), Equipment Type (equipment.equipment_type) and the machining
// sub-type (manufacturing_operations.machining_operation_subtype). STARbase's pages and the PDF report show
// the label, never the stored code ("MT-F", "Sample_Prep"). The stored values are unchanged: the Force App
// filters on the exact value `Machining`, and the sub-type codes are its contract.
//
// CANONICAL COPY. core/extensions/d1-report cannot import @d1/ui (it is not a workspace), so
// scripts/sync_geometry.sh copies this file, byte for byte, to core/extensions/d1-report/src/choiceLabels.ts
// (CI runs `sync_geometry.sh --check`). Edit this one and run the script. Keep it free of imports and of
// anything TypeScript cannot strip (no enums), so both copies load as they are.
//
// The Directus dropdowns carry the same words in their own choices (scripts/configure_directus.sql and the
// later migrations); a test in the Force App compares the sub-type list, and a test here compares Geometry
// with the sample creator's list (core/extensions/d1-geometry-preview/src/geometry.ts).

export type ChoiceKind = 'geometry' | 'surfaceFinish' | 'equipmentType' | 'machiningSubtype';

export interface Choice { value: string; text: string }

export const GEOMETRY_CHOICES: Choice[] = [
	{ value: 'disc', text: 'Disc' },
	{ value: 'ring', text: 'Ring' },
	{ value: 'cylinder', text: 'Cylinder' },
	{ value: 'block', text: 'Block' },
	{ value: 'plate', text: 'Plate' },
	{ value: 'bar', text: 'Bar' },
	{ value: 'round_bar', text: 'Round bar' },
	{ value: 'tensile_coupon', text: 'Tensile coupon (ISO 6892)' },
	{ value: 'bend_bar', text: 'Bend / fatigue bar (ISO 7438)' },
	{ value: 'powder', text: 'Powder / Compact' },
	{ value: 'other', text: 'Other' },
];

export const SURFACE_FINISH_CHOICES: Choice[] = [
	{ value: 'none', text: 'None' },
	{ value: 'rough_machined', text: 'Rough machined' },
	{ value: 'medium_machined', text: 'Medium machined' },
	{ value: 'finish_machined', text: 'Finish machined' },
	{ value: 'ground', text: 'Ground' },
	{ value: 'polished', text: 'Polished' },
	{ value: 'mirror', text: 'Mirror' },
	{ value: 'as_produced', text: 'As produced' },
];

// The 29 values stored in `equipment` (2026-10-14). A value added later still shows, humanised.
export const EQUIPMENT_TYPE_CHOICES: Choice[] = [
	{ value: 'Atomiser', text: 'Atomiser' },
	{ value: 'Binder_Jet_Printer', text: 'Binder jet printer' },
	{ value: 'Cutter', text: 'Cutter' },
	{ value: 'DED_Printer', text: 'DED printer' },
	{ value: 'Dilatometer', text: 'Dilatometer' },
	{ value: 'EBM_Printer', text: 'EBM printer' },
	{ value: 'EPMA', text: 'EPMA' },
	{ value: 'Extrusion', text: 'Extrusion' },
	{ value: 'FAST', text: 'FAST' },
	{ value: 'Grinder_Polisher', text: 'Grinder / polisher' },
	{ value: 'Heating_Stage', text: 'Heating stage' },
	{ value: 'HIP', text: 'HIP' },
	{ value: 'Impregnation_Unit', text: 'Impregnation unit' },
	{ value: 'Indentation_Plastometer', text: 'Indentation plastometer' },
	{ value: 'LPBF_Printer', text: 'LPBF printer' },
	{ value: 'Machining', text: 'Machining' },
	{ value: 'Melting_Furnace', text: 'Melting furnace' },
	{ value: 'Mill', text: 'Mill' },
	{ value: 'Mounting_Press', text: 'Mounting press' },
	{ value: 'Optical_Microscope', text: 'Optical microscope' },
	{ value: 'Powder_Mixer', text: 'Powder mixer' },
	{ value: 'Sample_Prep', text: 'Sample prep' },
	{ value: 'SEM', text: 'SEM' },
	{ value: 'SEM_FIB', text: 'SEM-FIB' },
	{ value: 'Spheroidiser', text: 'Spheroidiser' },
	{ value: 'TEM', text: 'TEM' },
	{ value: 'Thermomechanical_Sim', text: 'Thermomechanical simulator' },
	{ value: 'Universal_Tester', text: 'Universal tester' },
	{ value: 'Welder', text: 'Welder' },
];

// The Force App's twelve codes, in its order (MT = turning, MM = milling). The dash is an en dash.
export const MACHINING_SUBTYPE_CHOICES: Choice[] = [
	{ value: 'MT-F', text: 'Turning – Facing' },
	{ value: 'MT-R', text: 'Turning – Roughing' },
	{ value: 'MT-O', text: 'Turning – OD' },
	{ value: 'MT-G', text: 'Turning – Grooving' },
	{ value: 'MT-B', text: 'Turning – Boring' },
	{ value: 'MT-H', text: 'Turning – Threading' },
	{ value: 'MT-P', text: 'Turning – Parting' },
	{ value: 'MT-D', text: 'Turning – Drilling' },
	{ value: 'MM-F', text: 'Milling – Facing' },
	{ value: 'MM-R', text: 'Milling – Roughing' },
	{ value: 'MM-S', text: 'Milling – Slotting' },
	{ value: 'MM-D', text: 'Milling – Drilling' },
];

export const CHOICES: Record<ChoiceKind, Choice[]> = {
	geometry: GEOMETRY_CHOICES,
	surfaceFinish: SURFACE_FINISH_CHOICES,
	equipmentType: EQUIPMENT_TYPE_CHOICES,
	machiningSubtype: MACHINING_SUBTYPE_CHOICES,
};

const LABELS: Record<ChoiceKind, Map<string, string>> = {
	geometry: new Map(GEOMETRY_CHOICES.map((c) => [c.value, c.text])),
	surfaceFinish: new Map(SURFACE_FINISH_CHOICES.map((c) => [c.value, c.text])),
	equipmentType: new Map(EQUIPMENT_TYPE_CHOICES.map((c) => [c.value, c.text])),
	machiningSubtype: new Map(MACHINING_SUBTYPE_CHOICES.map((c) => [c.value, c.text])),
};

// "pending_processing" -> "Pending processing". The same rule as `humanise` in status.ts (a test keeps them
// equal); repeated here because this file must have no imports.
function humanised(value: string): string {
	const text = value.replace(/_/g, ' ').trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * The label for a stored value. A value outside the table (a legacy free-text geometry, a choice added
 * later) still shows, humanised; an empty value gives ''.
 */
export function choiceLabel(kind: ChoiceKind, value: unknown): string {
	if (value === null || value === undefined) return '';
	const raw = String(value).trim();
	if (!raw) return '';
	return LABELS[kind].get(raw) ?? humanised(raw);
}

/** Which of the four a column is (null for any other column). */
export function choiceKindFor(collection: string, field: string): ChoiceKind | null {
	if (collection === 'physical_samples' && field === 'form') return 'geometry';
	if (collection === 'physical_samples' && field === 'surface_finish') return 'surfaceFinish';
	if (collection === 'equipment' && field === 'equipment_type') return 'equipmentType';
	if (collection === 'manufacturing_operations' && field === 'machining_operation_subtype') return 'machiningSubtype';
	return null;
}
