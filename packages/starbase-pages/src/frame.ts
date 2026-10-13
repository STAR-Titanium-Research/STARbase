import type { Component } from 'vue';

// The chrome around a page, installed by the host: in the Directus module, Directus's <private-view>
// with the Explorer nav in its navigation slot; in STARbase, its own shell's content area. A page
// renders <ExplorerView :title> and gets whichever is installed.
let frame: Component | null = null;

export function setPageFrame(c: Component | null): void {
	frame = c;
}

export function usePageFrame(): Component {
	if (!frame) throw new Error('@d1/starbase-pages: no page frame. The app must call setPageFrame() before rendering a page.');
	return frame;
}
