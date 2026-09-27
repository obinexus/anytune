/**
 * The browser demo: the .obix UI compiled by the OBIX Vue frontend and run on the official Vue runtime (tools/obix/vite-plugin.ts). `npm run dev` serves it,
 * `npm run build` writes it to dist/app (beside the IR trace, dist/obix-ir), `npm run preview` serves the build.
 */
import { defineConfig } from 'vite';
import { obixVue } from './tools/obix/vite-plugin.ts';

export default defineConfig({
  plugins: [obixVue()],
  // the render functions are compiled ahead of time: Vue's runtime-only build, with the options API and the devtools of production turned off
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
  },
});
