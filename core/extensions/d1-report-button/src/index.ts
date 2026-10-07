import { defineInterface } from '@directus/extensions-sdk';
import Interface from './interface.vue';

// A presentation button that opens the printable PDF report (d1-report endpoint)
// for the current item. Drop it on any collection's form — samples default to the
// sample report, manufacturing_operations to the operation report, test_sessions to the
// test report, or set the type.
export default defineInterface({
	id: 'd1-report-button',
	name: 'Generate PDF',
	icon: 'picture_as_pdf',
	description: 'Opens the printable PDF report for this record.',
	component: Interface,
	hideLabel: true,
	types: ['alias'],
	localTypes: ['presentation'],
	group: 'presentation',
	options: [
		{
			field: 'label',
			name: 'Button label',
			type: 'string',
			meta: { interface: 'input', width: 'half', options: { placeholder: 'Generate PDF' } },
			schema: { default_value: 'Generate PDF' },
		},
		{
			field: 'report',
			name: 'Report type',
			type: 'string',
			meta: {
				interface: 'select-dropdown',
				width: 'half',
				options: {
					choices: [
						{ text: 'Auto (by collection)', value: 'auto' },
						{ text: 'Sample overview', value: 'sample' },
						{ text: 'Operation datasheet', value: 'operation' },
						{ text: 'Test datasheet', value: 'test' },
					],
				},
			},
			schema: { default_value: 'auto' },
		},
	],
});
