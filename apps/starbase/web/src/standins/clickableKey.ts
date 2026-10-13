// A clickable <v-icon> is role="button" tabindex="0": Enter and Space must click it, as they do a <button>.
// Other keys are left alone (Tab, Ctrl+K, ...).
export function activateOnKey(e: { key: string; currentTarget: unknown; preventDefault(): void }): void {
	if (e.key !== 'Enter' && e.key !== ' ') return;
	e.preventDefault();
	(e.currentTarget as { click(): void } | null)?.click();
}
