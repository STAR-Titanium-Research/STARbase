import { reactive } from 'vue';
import { editFrameUrl, readEditMessage } from '@d1/ui';

// STARbase's editor (host.openEditor, spec §3.4): a dialog framing d1-server's form-only page. The frame
// says 'ready' when it renders (so it is signed in and allowed to be framed), then 'saved' or 'cancelled'.
// No 'ready' within READY_TIMEOUT_MS (signed out inside the frame, the frame refused by CSP, d1-server
// slow) offers the same page in a new tab; that tab answers through window.opener, and without an answer,
// coming back to STARbase counts as saved so the record page refetches. Free of the DOM for its tests:
// createBrowserEditor (browserEditor.ts) supplies window.open and the focus event.

export type EditorPhase = 'closed' | 'loading' | 'ready' | 'refused' | 'tab';
export interface EditorState {
	phase: EditorPhase;
	url: string;
	collection: string;
	id: string;
	/** The browser refused to open the new tab. */
	blocked: boolean;
}
export interface EditorDeps {
	serverBase: string;
	readyTimeoutMs?: number;
	openTab(url: string): Window | null;
	onWindowFocus(cb: () => void): () => void;
}

export const READY_TIMEOUT_MS = 8000;

export function createEditor(deps: EditorDeps) {
	const state = reactive<EditorState>({ phase: 'closed', url: '', collection: '', id: '', blocked: false });
	const serverOrigin = new URL(deps.serverBase).origin;
	let resolve: ((r: 'saved' | 'cancelled') => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let frameWindow: () => unknown = () => null;
	let tab: Window | null = null;
	let offFocus: (() => void) | null = null;

	function stopWaiting() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	function finish(result: 'saved' | 'cancelled') {
		stopWaiting();
		offFocus?.();
		offFocus = null;
		tab = null;
		Object.assign(state, { phase: 'closed', url: '', collection: '', id: '', blocked: false });
		const r = resolve;
		resolve = null;
		r?.(result);
	}

	function open(collection: string, id: string): Promise<'saved' | 'cancelled'> {
		if (resolve) finish('cancelled');
		Object.assign(state, { phase: 'loading', url: editFrameUrl(deps.serverBase, collection, id), collection, id, blocked: false });
		timer = setTimeout(() => {
			timer = null;
			if (state.phase === 'loading') state.phase = 'refused';
		}, deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
		return new Promise((r) => {
			resolve = r;
		});
	}

	function onMessage(event: { origin: string; source: unknown; data: unknown }) {
		if (state.phase === 'closed') return;
		const source = state.phase === 'tab' ? tab : frameWindow();
		const msg = readEditMessage(event, { origin: serverOrigin, source, collection: state.collection, id: state.id });
		if (!msg) return;
		if (msg.result === 'ready') {
			stopWaiting();
			if (state.phase === 'loading' || state.phase === 'refused') state.phase = 'ready';
			return;
		}
		finish(msg.result);
	}

	function openInTab() {
		stopWaiting();
		const w = deps.openTab(state.url);
		if (!w) {
			Object.assign(state, { phase: 'refused', blocked: true });
			return;
		}
		tab = w;
		state.phase = 'tab';
		offFocus = deps.onWindowFocus(() => finish('saved'));
	}

	return {
		state,
		open,
		attachFrame: (get: () => unknown) => void (frameWindow = get),
		onMessage,
		openInTab,
		close: () => finish('cancelled'),
		done: () => finish('saved'),
	};
}

export type Editor = ReturnType<typeof createEditor>;
