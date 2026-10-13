// "Open record" goes through the permanent link on the Directus host (/d1-links/go/r/…), which
// forwards to the record's STARbase page, or its Data Studio form when STARbase has none. The Force
// App needs no STARbase setting of its own (spec 2026-10-13-directus-headless §5.2).
export function recordLink(directusUrl: string, collection: string, id: string | number): string {
	return `${directusUrl.replace(/\/+$/, '')}/d1-links/go/r/${collection}/${encodeURIComponent(String(id))}`;
}
