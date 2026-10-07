import type { Router } from 'vue-router';

// /d1-report/* is an API endpoint page (printable HTML), not an app route: open it in a new tab,
// same session. Everything else: the Directus app router base is already /admin, so push the bare
// path.
export function go(router: Router, to: string): void {
	if (to.startsWith('/d1-report/')) window.open(to, '_blank', 'noopener');
	else router.push(to);
}
