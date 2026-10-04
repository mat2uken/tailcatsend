'use strict';
// Catch accidental real HTTP/socket use in tests. This is a test guard, not an OS sandbox.
const deny = () => { throw new Error('Real network is forbidden in privacy tests'); };
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = deny;
  transport.get = deny;
}
const net = require('node:net');
net.connect = net.createConnection = deny;
net.Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:dgram').createSocket = deny;
require('node:module').syncBuiltinESMExports();
