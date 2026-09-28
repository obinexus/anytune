/**
 * The browser demo, on either runtime, from the same .obix files (tools/obix/vite-plugin.ts):
 *
 *   default (`npm run dev`, `dev:vue`, `build`, `preview`)  the UI compiled by the OBIX Vue frontend, run on the official Vue runtime — dist/app
 *   `--mode native` (`dev:native`, `build:native`, `preview:native`)  the UI lowered to canonical DOP IR, run by OBIX's native runtime, no Vue — dist/app-native
 *
 * The browser entry imports its mount as `#anytune-mount` (package.json "imports": the Vue harness); native mode points it at src/harness/mount-native.ts.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { obixVue } from './tools/obix/vite-plugin.ts';

export default defineConfig(({ mode }) => ({
  plugins: [obixVue()],
  resolve: mode === 'native' ? { alias: { '#anytune-mount': fileURLToPath(new URL('./src/harness/mount-native.ts', import.meta.url)) } } : {},
  // the render functions are compiled ahead of time: Vue's runtime-only build, with the options API and the devtools of production turned off
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: mode === 'native' ? 'dist/app-native' : 'dist/app',
    emptyOutDir: true,
  },
}));
