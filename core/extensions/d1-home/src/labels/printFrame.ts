// Print a rendered label document: the same html as the preview (without its screen-only outlines) goes into
// a hidden, off-screen iframe and its window is printed. The iframe is sandboxed: allow-modals is what lets
// print() open the print dialog, allow-same-origin lets this page call it. The document has no scripts.
// One iframe per print, removed when the dialog is done (a browser that prints asynchronously fires afterprint).

const FALLBACK_MS = 120_000;

export function printLabels(html: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const frame = document.createElement('iframe');
		frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
		frame.setAttribute('aria-hidden', 'true');
		frame.setAttribute('tabindex', '-1');
		frame.title = 'Labels to print';
		// Off-screen but not display:none (some browsers print nothing from a hidden frame).
		frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
		let done = false;
		const finish = (err?: unknown) => {
			if (done) return;
			done = true;
			frame.remove();
			if (err) reject(err);
			else resolve();
		};
		frame.onload = () => {
			const win = frame.contentWindow;
			if (!win) return finish(new Error('The print frame did not open.'));
			try {
				win.addEventListener('afterprint', () => finish());
				win.focus();
				win.print();
				// Chrome returns when the dialog closes; others return at once and fire afterprint later.
				setTimeout(() => finish(), FALLBACK_MS);
			} catch (e) {
				finish(e);
			}
		};
		frame.srcdoc = html;
		document.body.appendChild(frame);
	});
}
