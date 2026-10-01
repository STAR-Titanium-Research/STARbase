// App-wide confirmation/prompt dialog — the replacement for window.confirm() AND window.prompt()
// on every gate that guards a crucial action (disabling a safety alarm, silencing a tripped one,
// discarding a capture, quitting mid-recording, naming a new NI-DAQ channel).
//
// Why not window.confirm()/window.prompt(): under Electron,
//   - window.prompt() throws "prompt() is not supported." outright — Electron's BrowserWindow has
//     no native implementation of it at all (unlike alert()/confirm(), which it does implement via
//     a blocking native dialog). NidaqPage.vue's "+ New aux channel…" and "+ Virtual" buttons both
//     called it directly with no try/catch, so clicking them threw immediately and silently —
//     nothing appeared, nothing was created, and there was no visible error. Confirmed with an
//     isolated Electron probe outside the app: `window.prompt()` → `prompt() is not supported.`
//   - window.confirm(), where it DOES work, opens a NATIVE OS dialog, which blocks the renderer's
//     event loop (the live force stream and alarm tone stall while it is up), cannot be styled (a
//     destructive action looks identical to a benign one), and is invisible to Playwright's CDP
//     dialog interception, so every gate built on it had to be bypassed in tests rather than
//     covered (see commit d0b075c, which had to add a FORCE_APP_TEST_HOOKS escape hatch to stop
//     checkAlarmsBeforeStart() hanging the e2e suite for the full 120s timeout).
// A plain DOM dialog fixes all of this: it actually works, is non-blocking, themeable, and a real
// button/input Playwright can drive — so these gates get tested instead of skipped or silently broken.
import { reactive, readonly } from 'vue';

export type ConfirmTone = 'default' | 'warning' | 'danger';

export interface ConfirmStat {
	label: string;
	value: string;
}

interface BaseOptions {
	title: string;
	/** Optional supporting detail rendered smaller under the message. */
	detail?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	tone?: ConfirmTone;
}

export interface ConfirmOptions extends BaseOptions {
	/** The question. Keep it specific about consequence — "you will not be warned if…" beats "are you sure?". */
	message: string;
	/** Readouts shown as a table — e.g. the measured values of the alarms being silenced, so the
	 *  operator confirms against real numbers rather than a generic prompt. */
	stats?: ConfirmStat[];
}

export interface PromptOptions extends BaseOptions {
	/** The question/instruction. Optional — unlike confirm, a prompt's title often says enough
	 *  ("Name for the new Aux channel"). */
	message?: string;
	defaultValue?: string;
	placeholder?: string;
	/** Return a non-empty string to reject the current value and show it as an inline error;
	 *  return '' or undefined to accept. Re-run on every confirm attempt, not on every keystroke. */
	validate?: (value: string) => string | undefined;
}

interface ConfirmRequest extends ConfirmOptions {
	kind: 'confirm';
	resolve: (ok: boolean) => void;
}
interface PromptRequest extends PromptOptions {
	kind: 'prompt';
	resolve: (value: string | null) => void;
}
type PendingRequest = ConfirmRequest | PromptRequest;

const state = reactive({
	current: null as PendingRequest | null,
	// Live input text while a prompt is open. Separate from `current` (rather than mutating it
	// directly) because `confirmState` below is exposed read-only — this is the one piece of the
	// dialog's state the component itself is allowed to drive, via setPromptValue().
	promptValue: '',
	promptError: '' as string | undefined,
});

// Requests that arrived while another dialog was open. Stacking two dialogs would hide one behind
// the other and strand its promise unresolved (a caller awaiting it would hang forever), so they
// are shown strictly one at a time, in order.
const queue: PendingRequest[] = [];
let active: PendingRequest | null = null;

function showNext(): void {
	active = queue.shift() ?? null;
	state.current = active;
	state.promptValue = active?.kind === 'prompt' ? (active.defaultValue ?? '') : '';
	state.promptError = '';
}

/**
 * Ask the operator to confirm an action. Resolves true only on explicit confirmation — Escape,
 * backdrop click, and Cancel all resolve false, so the safe outcome is the default on every path.
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		queue.push({ ...opts, kind: 'confirm', resolve });
		if (!active) showNext();
	});
}

/**
 * Ask the operator for a short piece of text — the working replacement for window.prompt(), which
 * Electron does not implement. Resolves the entered string on confirmation, or null on Escape,
 * backdrop click, or Cancel — mirroring window.prompt()'s own null-on-cancel contract, so existing
 * `if (!name) return;` call sites need no change beyond swapping the call itself.
 */
export function promptAction(opts: PromptOptions): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		queue.push({ ...opts, kind: 'prompt', resolve });
		if (!active) showNext();
	});
}

/** Called by ConfirmDialog.vue's text input only, while a prompt is active. */
export function setPromptValue(v: string): void {
	state.promptValue = v;
	if (state.promptError) state.promptError = '';
}

/** Called by ConfirmDialog.vue only — `false`/`null` for cancel, `true`/the entered string to
 * confirm. A prompt whose `validate` rejects the current value stays open with the error shown,
 * rather than resolving. */
export function resolveActive(result: boolean | string | null): void {
	const req = active;
	if (!req) return;
	if (req.kind === 'prompt' && typeof result === 'string') {
		const err = req.validate?.(result);
		if (err) {
			state.promptError = err;
			return; // keep the dialog open
		}
	}
	active = null;
	state.current = null;
	if (req.kind === 'confirm') req.resolve(result as boolean);
	else req.resolve(result as string | null);
	// Let the closing dialog unmount before the next one mounts, so a queued prompt doesn't appear
	// to be the same dialog abruptly changing its text under the operator's cursor.
	if (queue.length) setTimeout(showNext, 0);
}

export const confirmState = readonly(state);
