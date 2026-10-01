import { defineModule } from '@directus/extensions-sdk';
import ModuleComponent from './Module.vue';
import MachiningDashboard from './views/MachiningDashboard.vue';
import SampleDashboard from './views/SampleDashboard.vue';
import FastDashboard from './views/FastDashboard.vue';
import NodeGraph from './views/NodeGraph.vue';

export default defineModule({
	id: 'd1-lab-dashboard',
	name: 'Lab Dashboard',
	icon: 'analytics',
	routes: [
		{
			path: '',
			component: ModuleComponent,
			children: [
				{ path: '', redirect: '/d1-lab-dashboard/samples' },
				{ path: 'samples', component: SampleDashboard },
				{ path: 'machining', component: MachiningDashboard },
				{ path: 'fast', component: FastDashboard },
				// standalone: the full-page graph has nothing to click until you search, so it gets
				// the search box the embedded Connections panels leave out.
				{ path: 'graph', component: NodeGraph, props: { standalone: true } },
			],
		},
	],
});
