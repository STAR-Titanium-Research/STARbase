import { defineInterface } from '@directus/extensions-sdk';
import ProjectItems from './ProjectItems.vue';
import { installDirectusHost } from '@d1/directus-host';

installDirectusHost();

// A read-only, presentation interface for the project form: one unified view of all
// the project's items (operations, equipment, tools, insert boxes, samples, tests)
// pulled from project_rollup — grouping DIRECT items with those inherited via the
// project's campaigns. Only non-empty sections render, and campaign-inherited items
// carry a coloured campaign-origin tag. Replaces the separate read-only rollup table.
export default defineInterface({
	id: 'd1-project-items',
	name: 'Project items (rolled-up, tagged)',
	icon: 'account_tree',
	description: 'Unified project items (direct + campaign-inherited), grouped, empty sections hidden, campaign-tagged.',
	component: ProjectItems,
	types: ['alias'],
	localTypes: ['presentation'],
	group: 'presentation',
	autoKey: true,
	options: [],
});
