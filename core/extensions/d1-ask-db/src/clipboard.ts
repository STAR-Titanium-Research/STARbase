/**
 * Copy text to the clipboard. `navigator.clipboard` only exists on secure origins (https or
 * localhost), so on a plain-http host fall back to a hidden textarea and `execCommand`.
 * Resolves true when the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Permission denied or an unfocused document: try the fallback below.
	}
	try {
		const el = document.createElement('textarea');
		el.value = text;
		el.setAttribute('readonly', '');
		el.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
		document.body.appendChild(el);
		el.select();
		el.setSelectionRange(0, text.length);
		const ok = document.execCommand('copy');
		document.body.removeChild(el);
		return ok;
	} catch {
		return false;
	}
}
