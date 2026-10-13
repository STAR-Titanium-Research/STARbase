import { safeNext, type SessionState } from './session';

export interface GuardTarget {
	path: string;
	fullPath: string;
	meta: Record<string | number | symbol, unknown>;
	query: Record<string, unknown>;
}

// Before every navigation (router.ts): signed out → the sign-in page, remembering where they were going;
// /signin while signed in → straight on to `next`; unreachable → the route goes through and App.vue shows
// the full-page "Can't reach the database" over it (spec §4). A string is a redirect.
export function guardDecision(to: GuardTarget, state: SessionState): true | string {
	if (to.path === '/signin') return state === 'signed-in' ? safeNext(to.query.next) : true;
	if (to.meta.public === true) return true;
	if (state === 'signed-out') return to.fullPath === '/' ? '/signin' : `/signin?next=${encodeURIComponent(to.fullPath)}`;
	return true;
}

// Old links in the Directus form (/home/samples/<id>?x=1, printed before STARbase) land on the same page.
export function homeRedirect(fullPath: string): string {
	const rest = fullPath.replace(/^\/home(?=[/?#]|$)/, '');
	if (rest === '' || rest === '/') return '/';
	return rest.startsWith('/') ? rest : `/${rest}`;
}
