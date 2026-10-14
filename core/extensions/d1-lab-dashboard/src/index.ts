import { defineModule } from '@directus/extensions-sdk';
import ModuleComponent from './Module.vue';
import MachiningDashboard from './views/MachiningDashboard.vue';
import SampleDashboard from './views/SampleDashboard.vue';
import FastDashboard from './views/FastDashboard.vue';
import { installDirectusHost } from '@d1/directus-host';

installDirectusHost();

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
			],
		},
	],
});
