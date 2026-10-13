import { defineModule } from '@directus/extensions-sdk';
import {
	HomeView,
	RegisterSample,
	PeopleView,
	SamplePage,
	CampaignPage,
	ProjectsIndex,
	ProjectPage,
	OperationPage,
	TestPage,
	LabelsPage,
	IndexRoute,
	installUsagePings,
} from '@d1/starbase-pages';
import { installDirectusHost } from '@d1/directus-host';

installDirectusHost({ onCreate: (host, router) => installUsagePings(router, host.api) });

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
		{ path: 'labels', component: LabelsPage },
		// After every static route (vue-router ranks static paths first): one list page per collection.
		{ path: ':slug', component: IndexRoute, props: true },
	],
});
