import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// routes.test.ts imports the page components, so .vue files must compile under vitest.
export default defineConfig({ plugins: [vue()] });
