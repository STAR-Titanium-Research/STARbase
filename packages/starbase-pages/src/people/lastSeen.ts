// A login's last sign-in as the People list shows it: "2 h ago", "yesterday", then a date once it is a week old. No Vue, so it is
// unit-tested. A person who never signed in (or whose time cannot be read) shows "—".

const DAY = 86_400;

export function lastSeen(iso: string | null | undefined, now: number = Date.now()): string {
	const t = iso ? Date.parse(iso) : NaN;
	if (Number.isNaN(t)) return '—';
	const s = Math.max(0, Math.floor((now - t) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < DAY) return `${Math.floor(s / 3600)} h ago`;
	const days = Math.floor(s / DAY);
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days} d ago`;
	return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
