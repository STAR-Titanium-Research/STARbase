// What an Explorer page needs from whatever app hosts it: the Directus module today, STARbase too.
// Pages and the kit reach the host only through here (and links.ts), so the kit stays host-neutral:
// the noSdkImports guard keeps the Directus extensions SDK out of every kit and page file.
import type { InjectionKey, Ref } from 'vue';

export interface HostRequestConfig {
	params?: Record<string, unknown>;
	timeout?: number;
	headers?: Record<string, string>;
	responseType?: 'json' | 'text' | 'blob' | 'arraybuffer';
}
export interface HostResponse {
	data: any;
}
// Axios-shaped on purpose: Directus's own API client is axios, and so is STARbase's client, so a failed
// request rejects the same way in both (e.response.status, which errorText/isForbidden read).
export interface HostApi {
	get(path: string, config?: HostRequestConfig): Promise<HostResponse>;
	post(path: string, body?: unknown, config?: HostRequestConfig): Promise<HostResponse>;
	patch(path: string, body?: unknown, config?: HostRequestConfig): Promise<HostResponse>;
	delete(path: string, config?: HostRequestConfig): Promise<HostResponse>;
}
// One field definition as Directus describes it (GET /fields/<collection>, or the app's fields store).
export type HostField = Record<string, any> & { field: string };

export interface ExplorerHost {
	api: HostApi;
	// An app route in its Directus form, e.g. '/home/samples?bookmark=3' (see links.ts).
	navigate(to: string): void;
	// A Data Studio path, e.g. '/content/samples'.
	openDataStudio(path: string): void;
	// The collection's field definitions, sorted as Data Studio shows them.
	fieldsFor(collection: string): Promise<HostField[]>;
	// Starts as the host's best synchronous guess and is corrected when the server answers, so a page
	// that uses it must react to changes (watch it), not read it once.
	isAdmin: Ref<boolean>;
	// False until the server has answered (or failed to): while false, isAdmin may still be a guess.
	adminKnown: Ref<boolean>;
	user: Ref<{ id: string; first_name?: string; role?: string | null } | null>;
}

export const EXPLORER_HOST: InjectionKey<ExplorerHost> = Symbol('ExplorerHost');

// A module-level factory, like the plotters' setForceHost: each app installs one at start-up, and a
// page asks for the host in its setup. The factory decides what to cache (one host per signed-in user).
let factory: (() => ExplorerHost) | null = null;

export function setExplorerHostFactory(f: (() => ExplorerHost) | null): void {
	factory = f;
}

export function useExplorerHost(): ExplorerHost {
	if (!factory) throw new Error('@d1/ui: no Explorer host. The app must call setExplorerHostFactory() before rendering a page.');
	return factory();
}
