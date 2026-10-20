import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// vue and vue-router keep per-app state behind module-level injection keys, so two installed copies break
// useRoute()/inject across packages (a clean `npm ci` once put a nested vue-router 5 in every workspace
// because @directus/extensions-sdk pins vue and peers vue-router 4: useRoute() returned undefined in the
// kit's components). Every workspace that imports them must resolve the same files.
const here = dirname(fileURLToPath(import.meta.url));
const workspaces = ['packages/d1-ui', 'packages/starbase-pages', 'packages/directus-host', 'packages/fast-plotting', 'apps/starbase/web'];

describe('workspaces share one copy of vue and vue-router', () => {
	for (const dep of ['vue', 'vue-router']) {
		it(dep, () => {
			const paths = workspaces.map((ws) => realpathSync(createRequire(resolve(here, '../../..', ws, 'package.json')).resolve(dep)));
			expect(new Set(paths).size, paths.join('\n')).toBe(1);
		});
	}
});
