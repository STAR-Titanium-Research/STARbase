import { defineInterface } from '@directus/extensions-sdk';
import OperationCode from './OperationCode.vue';

export default defineInterface({
	id: 'd1-operation-code',
	name: 'Operation Code',
	icon: 'tag',
	description:
		'Shows the operation code the database will build (live preview); type to set your own, ↻ to go back to automatic.',
	component: OperationCode,
	types: ['string'],
	group: 'standard',
	options: [],
});
