import type { RouteRecordRaw } from 'vue-router';

// The plotters as STARbase pages (spec §3.5, Q13): /plot/force?operation=<id>, /plot/fast?operation=<id>,
// /plot/conform?operation=<id>. Lazy: three.js, potree and the FAST charts load only when a plot is opened.
export const plotRoutes: RouteRecordRaw[] = [
	// A bare /plot is not a page of its own: without this it would fall into the generic ':slug' index route
	// ("There is no page called plot") and ping '/home/plot'. It opens the Force plotter, query kept.
	{ path: 'plot', redirect: (to) => ({ path: '/plot/force', query: to.query }) },
	{ path: 'plot/force', name: 'plot-force', component: () => import('./ForcePlotPage.vue') },
	{ path: 'plot/fast', name: 'plot-fast', component: () => import('./FastPlotPage.vue') },
	{ path: 'plot/conform', name: 'plot-conform', component: () => import('./ConformPlotPage.vue') },
];
