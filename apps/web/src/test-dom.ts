import { JSDOM } from 'jsdom';
import { afterEach } from 'node:test';

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
});
afterEach(() => dom.window.sessionStorage.clear());
