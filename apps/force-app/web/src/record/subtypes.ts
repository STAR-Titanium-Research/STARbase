// The machining operation sub-types (manufacturing_operations.machining_operation_subtype): the one list the
// Record page's Machine + Operator panel and the Edit capture metadata dialog offer. MT = turning, MM = milling
// (opTypeCategory in workspace.ts and force-plotting's cuttingMetrics read that prefix). The en dash in the
// labels is deliberate.
//
// subtypes.test.ts keeps this list equal to the Directus dropdown's choices in scripts/configure_inline_params.sql
// (values, labels and order) and to the label table STARbase and the PDF report use (@d1/ui's choiceLabels), so a
// change here is a change in all three: edit them together.
export const MACHINING_SUBTYPES = [
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
] as const;
