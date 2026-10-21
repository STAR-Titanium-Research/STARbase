import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// The chart tests render .vue components on the server (renderToString), so they must compile.
export default defineConfig({ plugins: [vue()] });
