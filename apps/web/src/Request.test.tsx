import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { request } from './request';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('HTTP requests accept empty DELETE responses and retain server validation errors without replaying mutations', async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ error: 'Quiz is not ready.' }, { status: 409 });
  };
  assert.equal(await request('/api/quiz', { method: 'DELETE' }), undefined);
  await assert.rejects(request('/api/room/start', { method: 'POST' }), /Quiz is not ready/);
  assert.equal(calls, 2);
});

test('network failures and non-JSON errors give actionable messages instead of parser errors', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(request('/api/quiz'), /Проверьте соединение/);
  globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  await assert.rejects(request('/api/quiz'), /502/);
});
