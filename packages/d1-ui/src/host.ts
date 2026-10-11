// What an Explorer page needs from whatever app hosts it. Today that is the Directus app (d1-home
// provides it); the Explorer is meant to leave Directus, and then only the provider changes.
// Components inject this instead of importing the host's SDK, so the kit stays host-neutral.
import type { InjectionKey, Ref } from 'vue';

export interface ExplorerHost {
	api: { get(path: string, config?: { params?: Record<string, unknown> }): Promise<{ data: any }> };
	// An app route without the host's base path, e.g. '/home/samples?bookmark=3'.
	navigate(to: string): void;
	// A Data Studio path, e.g. '/content/samples'.
	openDataStudio(path: string): void;
	isAdmin: Ref<boolean>;
	user: Ref<{ id: string; first_name?: string; role?: string | null } | null>;
}

export const EXPLORER_HOST: InjectionKey<ExplorerHost> = Symbol('ExplorerHost');
