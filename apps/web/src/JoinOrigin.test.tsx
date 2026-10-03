import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateIpv4, needsLanAddress } from './join-origin';

test('join diagnostic rejects loopback, unspecified and non-web origins', () => {
  for (const origin of ['http://localhost:5173', 'http://party.localhost', 'http://localhost.', 'http://127.0.0.2', 'http://127.1', 'http://0.0.0.0', 'http://[::1]', 'http://[::]', 'http://[::ffff:127.0.0.1]', 'http://169.254.59.101:5173', 'http://224.0.0.1', 'http://255.255.255.255', 'file:///', 'null']) {
    assert.equal(needsLanAddress(origin), true, origin);
  }
});

test('join diagnostic stays absent for LAN addresses and non-localhost names', () => {
  for (const origin of ['http://192.168.1.50:5173', 'http://10.0.0.5:5173', 'http://quiz.local:5173', 'https://party.example', 'http://[fd00::50]:5173']) {
    assert.equal(needsLanAddress(origin), false, origin);
  }
});


test('LAN discovery accepts only usable private IPv4 ranges', () => {
  for (const address of ['10.0.0.5', '172.16.0.2', '172.31.255.2', '192.168.178.37']) assert.equal(isPrivateIpv4(address), true, address);
  for (const address of ['127.0.0.2', '169.254.59.101', '0.0.0.0', '172.15.0.2', '172.32.0.2', '8.8.8.8', '192.168.1.999', '10.1.2', 'fd00::50']) assert.equal(isPrivateIpv4(address), false, address);
});
