import { createEditor, type Editor } from './editor';

export function createBrowserEditor(serverBase: string): Editor {
	return createEditor({
		serverBase,
		// Not 'noopener': the form page answers through window.opener, at STARbase's origin as d1-server knows it (STARBASE_URL) only.
		openTab: (url) => window.open(url, '_blank'),
		onWindowFocus: (cb) => {
			const h = () => cb();
			window.addEventListener('focus', h);
			return () => window.removeEventListener('focus', h);
		},
	});
}
