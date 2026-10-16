// "Open record" goes through the permanent link on the Directus host (/d1-links/go/r/…), which
// forwards to the record's STARbase page, or its Data Studio form when STARbase has none. The Force
// App needs no STARbase setting of its own (spec 2026-10-13-directus-headless §5.2).
export function recordLink(directusUrl: string, collection: string, id: string | number): string {
	return `${directusUrl.replace(/\/+$/, '')}/d1-links/go/r/${collection}/${encodeURIComponent(String(id))}`;
}

// "Forgot password?" on the sign-in page: STARbase's /forgot-password through the same permanent link (/d1-links/go/p/<page>), with the
// e-mail typed so far (if any) carried along to prefill the form. The reset e-mail's link lands on STARbase, in the browser, because the
// desktop shell cannot receive it; the person signs in here afterwards with the new password.
export function forgotPasswordLink(directusUrl: string, email = ''): string {
	const base = `${directusUrl.replace(/\/+$/, '')}/d1-links/go/p/forgot-password`;
	return email.trim() ? `${base}?email=${encodeURIComponent(email.trim())}` : base;
}
