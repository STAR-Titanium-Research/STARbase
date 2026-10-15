import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// The form and picker-mode tests render .vue components on the server (renderToString), so they must compile.
export default defineConfig({ plugins: [vue()] });
