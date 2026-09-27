/**
 * What "obix" resolves to in the Phase-5 demo build: the allowlisted, Vue-compatible authoring primitives (allowlist.ts), each Vue's own function. A DEMO
 * HARNESS — not the OBIX runtime, which does not exist yet. Only an .obix component may import "obix" (register.ts, the Vite plugin), and nothing else is here.
 */
export { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, toRef, toRefs, unref, watch, watchEffect } from 'vue';
