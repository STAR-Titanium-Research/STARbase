import { openLink } from '@d1/ui';
import type { Router } from 'vue-router';

// Follow a Home tile's link: a page of this app, or (reports, Data Studio) a new tab.
export function go(router: Router, to: string): void {
	openLink(to, router);
}
