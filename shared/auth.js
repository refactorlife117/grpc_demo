// ============================================================================
// Service-to-service AUTHENTICATION + AUTHORIZATION, as gRPC interceptors.
//
// Interceptors are gRPC's middleware. They run around every call, so the
// business handlers (CreateUser, GetUser...) don't contain any auth code.
//
//   CALLER (client interceptor)              RECEIVER (server interceptor)
//   ---------------------------              -----------------------------
//   sign a JWT with MY private key   ──▶     1. AUTHENTICATION: who is this?
//     iss = "order-service" (me)               - find the caller's PUBLIC key by `iss`
//     aud = "user-service"  (target)           - verify signature, expiry, audience
//     exp = now + 5 min                        - fail -> UNAUTHENTICATED
//     put it in metadata:                      2. AUTHORIZATION: may they do this?
//     authorization: Bearer <jwt>              - look up the method in the policy
//                                              - caller not listed -> PERMISSION_DENIED
//                                              3. ok -> continue to the handler
// ============================================================================
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const grpc = require('@grpc/grpc-js');

const KEYS_DIR = process.env.KEYS_DIR || path.join(__dirname, '..', 'keys');
const TOKEN_TTL_SECONDS = 300;

function readKey(file) {
  const fullPath = path.join(KEYS_DIR, file);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing ${fullPath}. Run: npm run keys:generate`);
    process.exit(1);
  }
  return fs.readFileSync(fullPath, 'utf8');
}

// The "registry" of services we trust: every <name>.public.pem in keys/.
// The filename IS the identity. Adding a new service = dropping its public key here.
// (A bigger system would fetch these from a JWKS endpoint or a service registry.)
function loadTrustedPublicKeys() {
  const keys = {};
  for (const file of fs.readdirSync(KEYS_DIR)) {
    const match = file.match(/^(.+)\.public\.pem$/);
    if (match) keys[match[1]] = fs.readFileSync(path.join(KEYS_DIR, file), 'utf8');
  }
  return keys;
}

function signServiceToken({ issuer, audience, privateKey, expiresIn = TOKEN_TTL_SECONDS }) {
  return jwt.sign({}, privateKey, {
    algorithm: 'RS256',
    issuer,           // who I am
    subject: issuer,
    audience,         // who this token is FOR. user-service rejects a token meant for order-service
    expiresIn,        // short-lived, so a leaked token is only useful for a few minutes
  });
}

// ---------------------------------------------------------------------------
// CLIENT SIDE: attach a token to every outgoing call.
//   new userProto.UserService(addr, creds, {
//     interceptors: [clientAuthInterceptor('order-service', 'user-service')],
//   })
// ---------------------------------------------------------------------------
function clientAuthInterceptor(selfName, targetName) {
  const privateKey = readKey(`${selfName}.private.pem`);
  let cached = { token: null, expiresAt: 0 };

  // Signing costs CPU, so reuse the token until it's about to expire.
  function getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cached.expiresAt - now < 30) {
      cached = {
        token: signServiceToken({ issuer: selfName, audience: targetName, privateKey }),
        expiresAt: now + TOKEN_TTL_SECONDS,
      };
    }
    return cached.token;
  }

  return (options, nextCall) =>
    new grpc.InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        metadata.set('authorization', `Bearer ${getToken()}`);
        next(metadata, listener);
      },
    });
}

// ---------------------------------------------------------------------------
// SERVER SIDE: verify the token, then check the policy.
//
// `policy` maps full method paths to the services allowed to call them:
//   { '/user.UserService/GetUser': ['gateway', 'order-service'] }
// A method that isn't listed is denied to everyone (default deny).
// ---------------------------------------------------------------------------
function authenticate(metadata, selfName, trustedKeys) {
  const header = metadata.get('authorization')[0];
  if (!header || !header.startsWith('Bearer ')) {
    throw new Error('missing bearer token');
  }
  const token = header.slice('Bearer '.length);

  // Read `iss` WITHOUT verifying, only to pick which public key to verify with.
  // Nothing from this unverified payload is trusted until jwt.verify passes.
  const unverified = jwt.decode(token);
  if (!unverified) throw new Error('malformed token');
  const issuer = unverified.iss;
  const publicKey = trustedKeys[issuer];
  if (!publicKey) throw new Error(`unknown service "${issuer}"`);

  // Pin the algorithm. Never let the token's header choose it ("alg: none" attacks).
  jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer,
    audience: selfName,
    clockTolerance: 5,
  });
  return issuer;
}

function serverAuthInterceptor(selfName, policy) {
  const trustedKeys = loadTrustedPublicKeys();

  return (methodDescriptor, call) =>
    new grpc.ServerInterceptingCall(call, {
      start(next) {
        next({
          onReceiveMetadata(metadata, mdNext) {
            const method = methodDescriptor.path; // e.g. "/user.UserService/GetUser"
            const reqId = metadata.get('x-request-id')[0] || '-';
            const log = (msg) => console.log(`[${selfName}] [${reqId}] auth: ${msg}`);

            // 1. Authentication
            let caller;
            try {
              caller = authenticate(metadata, selfName, trustedKeys);
            } catch (err) {
              log(`REJECT ${method}: ${err.message}`);
              // Ending the call here means the handler never runs.
              return call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: err.message });
            }

            // 2. Authorization
            const allowed = policy[method] || [];
            if (!allowed.includes(caller)) {
              log(`DENY   ${caller} -> ${method}`);
              return call.sendStatus({
                code: grpc.status.PERMISSION_DENIED,
                details: `${caller} is not allowed to call ${method}`,
              });
            }

            log(`ALLOW  ${caller} -> ${method}`);
            // Hand the verified identity to the handler. set() overwrites,
            // so a caller can't fake this header by sending it themselves.
            metadata.set('x-authenticated-caller', caller);
            mdNext(metadata);
          },
        });
      },
    });
}

module.exports = {
  clientAuthInterceptor,
  serverAuthInterceptor,
  signServiceToken, // exported for scripts/auth-demo.js
  readKey,
};
