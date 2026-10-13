import type { Router } from 'vue-router';
import { setExplorerHostFactory, type ExplorerHost } from '@d1/ui';
import { useDirectusHost } from './directusHost';

export { useDirectusHost };

// Call once at module scope in each Directus extension that renders kit components or pages.
export function installDirectusHost(opts: { onCreate?: (host: ExplorerHost, router: Router) => void } = {}): void {
	setExplorerHostFactory(() => useDirectusHost(opts));
}
