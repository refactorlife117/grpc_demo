// Run with the services up: `npm run auth:demo`
//
// Calls user-service DIRECTLY (skipping the gateway) with different tokens,
// to show what authentication and authorization each block.
require('dotenv').config();
const crypto = require('crypto');
const { loadProto, grpc } = require('../shared/proto-loader');
const { signServiceToken, readKey } = require('../shared/auth');

const userProto = loadProto('user.proto').user;
const ADDR = process.env.USER_SERVICE_ADDR || 'localhost:50051';

// A plain client with NO auth interceptor. We attach tokens by hand.
const client = new userProto.UserService(ADDR, grpc.credentials.createInsecure());

const gatewayKey = readKey('gateway.private.pem');
const orderKey = readKey('order-service.private.pem');
// An attacker's own key pair. user-service has never seen its public key.
const attackerKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' });

function callWith(method, request, token) {
  const md = new grpc.Metadata();
  md.set('x-request-id', 'auth-demo');
  if (token) md.set('authorization', `Bearer ${token}`);

  return new Promise((resolve) => {
    if (method === 'ListUsers') {
      // streaming call: collect messages until end or error
      const users = [];
      const stream = client.ListUsers(request, md);
      stream.on('data', (u) => users.push(u));
      stream.on('end', () => resolve(`OK (${users.length} users)`));
      stream.on('error', (err) => resolve(`${grpc.status[err.code]}: ${err.details}`));
    } else {
      client[method](request, md, (err, res) =>
        resolve(err ? `${grpc.status[err.code]}: ${err.details}` : `OK ${JSON.stringify(res)}`)
      );
    }
  });
}

const token = (issuer, audience, privateKey, expiresIn) =>
  signServiceToken({ issuer, audience, privateKey, expiresIn });

const scenarios = [
  ['No token at all',
    'GetUser', { id: 1 }, null],
  ['Garbage token',
    'GetUser', { id: 1 }, 'not-a-jwt'],
  ['Forged: claims to be "gateway" but signed with attacker key',
    'GetUser', { id: 1 }, token('gateway', 'user-service', attackerKey)],
  ['Unknown service "billing-service"',
    'GetUser', { id: 1 }, token('billing-service', 'user-service', attackerKey)],
  ['Real gateway token, but meant for order-service (wrong audience)',
    'GetUser', { id: 1 }, token('gateway', 'order-service', gatewayKey)],
  ['Real gateway token, but expired',
    'GetUser', { id: 1 }, token('gateway', 'user-service', gatewayKey, -60)],
  ['order-service calls ListUsers (authenticated, but not in the policy)',
    'ListUsers', {}, token('order-service', 'user-service', orderKey)],
  ['order-service calls CreateUser (authenticated, but not in the policy)',
    'CreateUser', { name: 'x', email: 'x@x.com' }, token('order-service', 'user-service', orderKey)],
  ['order-service calls GetUser (allowed)',
    'GetUser', { id: 1 }, token('order-service', 'user-service', orderKey)],
  ['gateway calls ListUsers (allowed)',
    'ListUsers', {}, token('gateway', 'user-service', gatewayKey)],
];

(async () => {
  for (const [title, method, request, tok] of scenarios) {
    const result = await callWith(method, request, tok);
    console.log(`\n▶ ${title}\n  ${method} -> ${result}`);
  }
  client.close();
})();
