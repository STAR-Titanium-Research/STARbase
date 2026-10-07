import { defineInterface } from '@directus/extensions-sdk';
import CampaignOps from './CampaignOps.vue';

// Campaign operations manager whose "add" search is pre-filtered by the campaign's
// type — a Machining Trial only offers machining operations, etc. Assigning/removing
// sets the operation's campaign_id. Shown on the campaign form as an alias field.
export default defineInterface({
	id: 'd1-campaign-ops',
	name: 'Campaign overview and operations',
	icon: 'build',
	description: 'Campaign overview (samples, operations, tests, force-analysis status) and add/remove pickers; the operations search is pre-filtered by the campaign type.',
	component: CampaignOps,
	types: ['alias'],
	localTypes: ['presentation'],
	group: 'presentation',
	autoKey: true,
	options: [],
});
