import type { RouteRecordRaw } from 'vue-router';
import HomeView from './home.vue';
import RegisterSample from './register-sample.vue';
import PeopleView from './people.vue';
import SamplePage from './pages/SamplePage.vue';
import CampaignPage from './pages/CampaignPage.vue';
import ProjectsIndex from './pages/ProjectsIndex.vue';
import ProjectPage from './pages/ProjectPage.vue';
import OperationPage from './pages/OperationPage.vue';
import TestPage from './pages/TestPage.vue';
import LabelsPage from './pages/LabelsPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import ReportBugPage from './pages/ReportBugPage.vue';
import IndexRoute from './pages/IndexRoute.vue';

// Every STARbase page, relative to where the host mounts them: the Directus module at /home, the
// standalone app at /. The catch-all index route stays last (vue-router ranks static paths first anyway).
export const starbaseRoutes: RouteRecordRaw[] = [
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
	{ path: 'settings', component: SettingsPage },
	// No /home form (links.ts LOCAL_PAGES): written as '/report-bug' in the nav, in both hosts.
	{ path: 'report-bug', component: ReportBugPage },
	// After every static route: one list page per collection.
	{ path: ':slug', component: IndexRoute, props: true },
];
