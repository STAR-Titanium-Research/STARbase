import { defineModule } from '@directus/extensions-sdk';
import { installDirectusHost } from '@d1/directus-host';
import { installUsagePings, setPageFrame, starbaseRoutes } from '@d1/starbase-pages';
import DirectusFrame from './DirectusFrame.vue';

// The Directus Home module: the STARbase pages (@d1/starbase-pages) inside Data Studio, mounted at
// /home. The standalone STARbase app mounts the same routes at / with its own host and frame.
installDirectusHost({ onCreate: (host, router) => installUsagePings(router, host.api) });
setPageFrame(DirectusFrame);

export default defineModule({
	id: 'home',
	name: 'Home',
	icon: 'cottage',
	routes: starbaseRoutes,
});
