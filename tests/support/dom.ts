/**
 * A jsdom document as the global DOM, for the UI tests — installed before Vue's DOM runtime is loaded (it reads `document` when it loads). Import this module
 * first, and Vue and the components after it (dynamically).
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  if (!(name in g) || name === 'navigator') {
    Object.defineProperty(g, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
}

export const window = dom.window;
