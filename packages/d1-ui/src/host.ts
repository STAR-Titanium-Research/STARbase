// What an Explorer page needs from whatever app hosts it. Today that is the Directus app (d1-home
// provides it); the Explorer is meant to leave Directus, and then only the provider changes.
// Components inject this instead of importing the host's SDK, so the kit stays host-neutral.
import type { InjectionKey, Ref } from 'vue';

export interface ExplorerHost {
	api: {
		get(path: string, config?: { params?: Record<string, unknown> }): Promise<{ data: any }>;
		// Writes: the "Who has access" dialog calls the d1-record-access endpoint with these (the SDK's axios has them).
		post(path: string, body?: unknown, config?: { params?: Record<string, unknown> }): Promise<{ data: any }>;
		patch(path: string, body?: unknown, config?: { params?: Record<string, unknown> }): Promise<{ data: any }>;
		delete(path: string, config?: { params?: Record<string, unknown> }): Promise<{ data: any }>;
	};
	// An app route without the host's base path, e.g. '/home/samples?bookmark=3'.
	navigate(to: string): void;
	// A Data Studio path, e.g. '/content/samples'.
	openDataStudio(path: string): void;
	// Starts as the host's best synchronous guess and is corrected when the server answers, so a page
	// that uses it must react to changes (watch it), not read it once.
	isAdmin: Ref<boolean>;
	// False until the server has answered (or failed to): while false, isAdmin may still be a guess.
	adminKnown: Ref<boolean>;
	user: Ref<{ id: string; first_name?: string; role?: string | null } | null>;
}

export const EXPLORER_HOST: InjectionKey<ExplorerHost> = Symbol('ExplorerHost');
