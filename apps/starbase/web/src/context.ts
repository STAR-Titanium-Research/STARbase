import { inject, type InjectionKey } from 'vue';
import type { AxiosInstance } from 'axios';
import type { SessionGuard } from './api';
import type { Editor } from './editor/editor';
import type { Session } from './session';

// What main.ts builds once and the app's own components share (the shared pages use the Explorer host).
export interface AppContext {
	api: AxiosInstance;
	session: Session;
	guard: SessionGuard;
	editor: Editor;
}

export const APP: InjectionKey<AppContext> = Symbol('starbase-app');

export function useApp(): AppContext {
	const ctx = inject(APP);
	if (!ctx) throw new Error('STARbase: no app context (main.ts provides it).');
	return ctx;
}
