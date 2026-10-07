// Test-only: lets `node --test` load render.js, which imports './geometry' (a .ts file
// resolved by the extension bundler). Used via `node --import ./src/test-register.mjs`.
import { register } from 'node:module';

register('./test-resolve.mjs', import.meta.url);
