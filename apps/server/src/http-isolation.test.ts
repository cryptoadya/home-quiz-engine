import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import request from 'supertest';

test('automatic HTTP fixtures connect using the listening server address family', async () => {
  const server = createServer((_request, response) => response.end('fixture'));
  let address!: AddressInfo;
  server.on('listening', () => { address = server.address() as AddressInfo; });
  const pending = request(server).get('/');
  await pending.expect(200, 'fixture');
  // An IPv6 wildcard can share its port with an unrelated IPv4 listener on macOS.
  assert.equal(new URL(pending.url).hostname, address.family === 'IPv6' ? '[::1]' : '127.0.0.1');
  assert.equal(server.listening, false);
});
