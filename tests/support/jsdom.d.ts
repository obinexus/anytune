// The part of jsdom the UI tests use (jsdom ships no types; @types/jsdom is not a dependency of AnyTune).
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, options?: { readonly pretendToBeVisual?: boolean; readonly url?: string });
    readonly window: Window & typeof globalThis;
  }
}
