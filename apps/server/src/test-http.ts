import request from 'supertest';

// Loaded only by the test command. Supertest calls listen(0), then connects over
// IPv4 even when Node chose an IPv6 wildcard. On macOS that port can belong to a
// different IPv4 service. Connect to IPv6 loopback for IPv6 wildcard fixtures;
// preserve explicitly configured listeners (including the realtime fixtures).
const serverAddress = request.Test.prototype.serverAddress;
request.Test.prototype.serverAddress = function (app, path) {
  const url = serverAddress.call(this, app, path);
  const address = typeof app !== 'string' && 'address' in app ? app.address() : null;
  return address && typeof address !== 'string' && address.address === '::'
    ? url.replace('://127.0.0.1:', '://[::1]:')
    : url;
};
