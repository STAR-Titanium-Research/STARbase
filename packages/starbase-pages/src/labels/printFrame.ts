// Print a rendered label document: the same html as the preview (without its screen-only outlines) goes into
// a hidden, off-screen iframe and its window is printed. The iframe is sandboxed: allow-modals is what lets
// print() open the print dialog, allow-same-origin lets this page call it. The document has no scripts.
//
// There is one print frame at a time, kept in this module. The next print replaces it; it is removed when
// the browser says printing is over (afterprint) or the frame's page goes away (pagehide), never on a
// timer (a dialog can stay open for minutes, and a browser that prints in the background needs the frame).
// The promise settles when print() has returned: Chrome returns when the dialog closes, other browsers at once.

let current: HTMLIFrameElement | null = null;

const removed = new WeakSet<HTMLIFrameElement>();
function removeOnce(frame: HTMLIFrameElement): void {
	if (removed.has(frame)) return;
	removed.add(frame);
	frame.remove();
}

export function printLabels(html: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// Removing the old frame fires its pagehide, whose handler removes it again: in Chrome that nested remove()
		// throws ("no longer a child"), which would reject this print. removeOnce() makes removal happen once.
		const old = current;
		current = null;
		if (old) removeOnce(old);
		const frame = document.createElement('iframe');
		current = frame;
		frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
		frame.setAttribute('aria-hidden', 'true');
		frame.setAttribute('tabindex', '-1');
		frame.title = 'Labels to print';
		// Off-screen but not display:none (some browsers print nothing from a hidden frame).
		frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
		const drop = () => {
			if (current === frame) current = null;
			removeOnce(frame);
		};
		frame.onload = () => {
			const win = frame.contentWindow;
			if (!win) {
				drop();
				reject(new Error('The print frame did not open.'));
				return;
			}
			try {
				win.addEventListener('afterprint', drop);
				win.addEventListener('pagehide', drop);
				win.focus();
				win.print();
				resolve();
			} catch (e) {
				drop();
				reject(e);
			}
		};
		frame.srcdoc = html;
		document.body.appendChild(frame);
	});
}
