import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';

for (const [path, title] of [
  ['/admin', 'Admin'],
  ['/host', 'Host'],
  ['/screen', 'Screen'],
  ['/play', 'Player'],
]) {
  test(`${path} renders its interface`, () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)),
    );
    assert.match(markup, new RegExp(`<h1>${title}</h1>`));
  });
}
