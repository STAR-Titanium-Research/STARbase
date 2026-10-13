import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { starbaseCsp } from './src/csp';

// STARbase is served at the root of its own origin (https://starbase.<tailnet>.ts.net), in development
// and in production alike, so base is '/'. 127.0.0.1 and not localhost: the preview Directus is reached
// at 127.0.0.1 too, so the session cookie is same-site in development (spec §5).
// /brand/... in templates are files of public/, served as written: leave absolute URLs alone (vitest otherwise
// tries to read them from disk as imports).
export default defineConfig({
	base: '/',
	plugins: [vue({ template: { transformAssetUrls: { includeAbsolute: false } } })],
	server: { host: '127.0.0.1', port: 5190, strictPort: true },
	// The production CSP on the preview server too (Task 12 runs the e2e against `vite preview`), aimed at
	// the preview Directus unless STARBASE_D1_ORIGIN says otherwise.
	preview: {
		host: '127.0.0.1',
		port: 5190,
		strictPort: true,
		headers: { 'Content-Security-Policy': starbaseCsp(process.env.STARBASE_D1_ORIGIN ?? 'http://127.0.0.1:18057') },
	},
	test: { exclude: [...configDefaults.exclude, 'e2e/**'] },
});
