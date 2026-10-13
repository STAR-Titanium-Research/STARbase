// The label_settings singleton as the labels page reads and writes it: the lab contact email that every
// label's QR code carries. Pure helpers; the page does the requests.

// The database's CHECK (db/migrations/20261012000164_label_templates.sql): something@something.tld, no spaces.
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// A label_settings row (or null while unread) -> the contact email, or null when none is set.
export function contactEmailOf(row: unknown): string | null {
	if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
	const v = (row as Record<string, unknown>).contact_email;
	return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// What an admin typed in the contact box -> the value to PATCH. Blank clears it (null). Anything else must
// look like an email address, so the request the database would refuse is never sent.
export function parseContactInput(text: string): { ok: true; value: string | null } | { ok: false; error: string } {
	const v = text.trim();
	if (v === '') return { ok: true, value: null };
	if (!EMAIL_PATTERN.test(v)) return { ok: false, error: 'Enter an email address like lab@example.org, or leave it empty.' };
	return { ok: true, value: v };
}

// "Contact on labels: lab@example.org" or "No lab contact set".
export function contactLine(email: string | null): string {
	return email ? `Contact on labels: ${email}` : 'No lab contact set';
}
