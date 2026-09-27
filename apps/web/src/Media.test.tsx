import { dom } from './test-dom';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MediaManager } from './Media';
afterEach(cleanup);

test('media panel uploads, lists metadata, confirms deletion and refreshes readiness', async () => {
  const item = { id: 'm', name: 'picture.gif', kind: 'image', mimeType: 'image/gif', sizeBytes: 100 };
  const calls: string[] = []; let confirmed = false; let refreshed = 0;
  dom.window.confirm = () => confirmed;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    if (init?.method === 'POST') {
      assert.ok(init.body instanceof FormData); assert.ok(init.body.get('file'));
      return Response.json(item, { status: 201 });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json([]);
  };
  const view = render(createElement(MediaManager, { quizId: 'q', onPersistedChange: () => { refreshed++; } }));
  fireEvent.click(view.getByRole('button', { name: 'Manage media' }));
  await waitFor(() => assert.ok(view.getByText('No media uploaded.')));
  assert.equal((view.getByRole('button', { name: 'Upload media' }) as HTMLButtonElement).disabled, true);
  fireEvent.change(view.getByLabelText('Media file'), { target: { files: [new File(['GIF89a'], 'picture.gif', { type: 'image/gif' })] } });
  fireEvent.click(view.getByRole('button', { name: 'Upload media' }));
  await waitFor(() => assert.ok(view.getByText('picture.gif')));
  assert.ok(view.getByText(/image · image\/gif/));
  fireEvent.click(view.getByRole('button', { name: 'Delete media picture.gif' }));
  assert.equal(refreshed, 1); assert.equal(calls.length, 2);
  confirmed = true;
  fireEvent.click(view.getByRole('button', { name: 'Delete media picture.gif' }));
  await waitFor(() => assert.ok(view.getByText('Deleted picture.gif.')));
  assert.equal(refreshed, 2); assert.equal(view.queryByText('picture.gif'), null);
});

test('media panel reports list/upload/delete failures and keeps retry available', async () => {
  let fail = true;
  const item = { id: 'm', name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 100 };
  globalThis.fetch = async (_input, init) => fail ? Response.json({ error: 'Media unavailable.' }, { status: 400 })
    : init?.method === 'POST' ? Response.json(item) : Response.json([item]);
  dom.window.confirm = () => true;
  const view = render(createElement(MediaManager, { quizId: 'q', onPersistedChange: () => {} }));
  fireEvent.click(view.getByRole('button', { name: 'Manage media' }));
  await waitFor(() => assert.ok(view.getByRole('alert')));
  fireEvent.change(view.getByLabelText('Media file'), { target: { files: [new File(['bad'], 'clip.mp4')] } });
  fireEvent.click(view.getByRole('button', { name: 'Upload media' }));
  await waitFor(() => assert.ok(view.getByText('Upload failed.')));
  fail = false; fireEvent.click(view.getByRole('button', { name: 'Upload media' }));
  await waitFor(() => assert.ok(view.getByText('clip.mp4')));
  fail = true; fireEvent.click(view.getByRole('button', { name: 'Delete media clip.mp4' }));
  await waitFor(() => assert.ok(view.getByText('Delete failed.')));
  assert.ok(view.getByText('clip.mp4'));
});
