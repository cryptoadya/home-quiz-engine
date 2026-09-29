import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsLanAddress } from './join-origin';

test('join diagnostic rejects loopback, unspecified and non-web origins', () => {
  for (const origin of ['http://localhost:5173', 'http://party.localhost', 'http://localhost.', 'http://127.0.0.2', 'http://127.1', 'http://0.0.0.0', 'http://[::1]', 'http://[::]', 'http://[::ffff:127.0.0.1]', 'file:///', 'null']) {
    assert.equal(needsLanAddress(origin), true, origin);
  }
});

test('join diagnostic stays absent for LAN addresses and non-localhost names', () => {
  for (const origin of ['http://192.168.1.50:5173', 'http://10.0.0.5:5173', 'http://quiz.local:5173', 'https://party.example', 'http://[fd00::50]:5173']) {
    assert.equal(needsLanAddress(origin), false, origin);
  }
});
