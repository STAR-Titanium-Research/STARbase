import type { SessionState, SessionUser } from './session';

export type ShellView = 'unreachable' | 'route' | 'none';

// What App.vue shows. A signed-in page (and so the shell, whose Explorer nav needs the Explorer host that
// main.ts installs once someone is signed in) renders only for a signed-in user; the public pages (sign-in)
// always. Any other state on a signed-in page renders nothing until the guard's redirect completes: e.g.
// "Try again" finds the session gone, and the page must not mount before router.replace sends them to /signin.
export function shellView(state: SessionState, isPublic: boolean): ShellView {
	if (state === 'unreachable') return 'unreachable';
	return isPublic || state === 'signed-in' ? 'route' : 'none';
}

// The name the shell shows for the signed-in user: the first name, else the email (not every account has a
// first name), else nothing.
export function userLabel(user: SessionUser | null | undefined): string {
	return user?.first_name?.trim() || user?.email?.trim() || '';
}
