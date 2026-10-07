import { defineModule } from '@directus/extensions-sdk';
import HomeView from './home.vue';
import RegisterSample from './register-sample.vue';
import PeopleView from './people.vue';
import SamplePage from './pages/SamplePage.vue';
import CampaignPage from './pages/CampaignPage.vue';
import ProjectsIndex from './pages/ProjectsIndex.vue';
import ProjectPage from './pages/ProjectPage.vue';
import OperationPage from './pages/OperationPage.vue';
import TestPage from './pages/TestPage.vue';

// A friendly landing page for lab users plus guided task screens, so day-to-day
// work starts somewhere warm and simple instead of a raw collection form.
//
// It also hosts the Explorer pages (docs/superpowers/specs/2026-10-06-explorer-pages-design.md):
// one formatted page per main record type, reached through recordRoute() in @d1/ui.

export default defineModule({
	id: 'home',
	name: 'Home',
	icon: 'cottage',
	routes: [
		{ path: '', component: HomeView },
		{ path: 'register-sample', component: RegisterSample },
		{ path: 'people', component: PeopleView },
		{ path: 'projects', component: ProjectsIndex },
		{ path: 'projects/:id', component: ProjectPage, props: true },
		{ path: 'campaigns/:id', component: CampaignPage, props: true },
		{ path: 'samples/:id', component: SamplePage, props: true },
		{ path: 'operations/:id', component: OperationPage, props: true },
		{ path: 'tests/:id', component: TestPage, props: true },
	],
});
