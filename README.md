# gRPC Demo: service-to-service communication

Three small Node services that talk to each other over gRPC, backed by Postgres.

```
 curl / browser
      │  HTTP + JSON
      ▼
 ┌──────────────┐   gRPC    ┌───────────────┐
 │ API Gateway  │──────────▶│ User Service  │──▶ Postgres (users)
 │ Express:3000 │           │   :50051      │
 └──────┬───────┘           └───────▲───────┘
        │ gRPC                      │ gRPC   ◀── service-to-service
        ▼                           │
 ┌───────────────┐                  │
 │ Order Service │──────────────────┘
 │   :50052      │──▶ Postgres (orders)
 └───────────────┘
```

| Service | Role | File |
|---|---|---|
| User Service | gRPC **server** only. Owns the `users` table. | `user-service/server.js` |
| Order Service | gRPC **server** *and* gRPC **client** (calls User Service) | `order-service/server.js` |
| Gateway | Express HTTP server + gRPC **client**. Translates HTTP ↔ gRPC. | `gateway/server.js` |

## Run it

```bash
cp .env.example .env        # then put your DATABASE_URL in .env
npm install
npm run keys:generate       # gives each service its own RSA key pair (keys/)
npm run db:init             # creates the users + orders tables
npm start                   # starts all 3 services with colored logs
npm run auth:demo           # (in another terminal) try to break the auth
```

Or run each one in its own terminal to see them separately:
`npm run user-service`, `npm run order-service`, `npm run gateway`.

## Try it

```bash
# create users        (gateway -> user-service)
curl -X POST localhost:3000/users -H 'content-type: application/json' \
     -d '{"name":"Manish","email":"manish@example.com"}'

# list users          (server-streaming RPC)
curl localhost:3000/users

# create an order     (gateway -> order-service -> user-service)  <-- the interesting one
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
     -d '{"user_id":1,"product":"Keyboard","quantity":2,"price":49.99}'

# order for a user that doesn't exist -> 404, the NOT_FOUND came from user-service
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
     -d '{"user_id":99,"product":"Mouse","quantity":1,"price":10}'

# a user's orders
curl localhost:3000/users/1/orders
```

**Experiment:** stop user-service (Ctrl+C its terminal) and create an order again.
You'll get `503 UNAVAILABLE`. Order Service couldn't reach its dependency and said so cleanly.

## What happens on `POST /orders`, step by step

Watch the logs. Every line has the same request id, e.g. `[eca9dd0a]`:

```
[gateway]       [eca9dd0a] POST /orders
[order-service] [eca9dd0a] CreateOrder { user_id: 1, product: 'Keyboard', ... }
[order-service] [eca9dd0a]   -> calling user-service GetUser(1)
[user-service]  [eca9dd0a] GetUser id=1
[order-service] [eca9dd0a]   <- user-service replied: Manish
```

1. **Gateway** gets JSON over HTTP. It calls `orderClient.CreateOrder(...)`.
   The JS object is encoded to **protobuf binary** and sent over **HTTP/2**.
2. **Order Service** gets the decoded object in `call.request`.
   Before it saves anything, it needs to know whether user 1 exists.
3. It does **not** query the `users` table. It calls `userClient.GetUser({id: 1})`,
   which is a second gRPC hop. **This is service-to-service communication.**
4. **User Service** looks up Postgres and replies with a `User` message (or a `NOT_FOUND` error).
5. Order Service inserts the order and replies. The gateway turns the reply into JSON.

## Key concepts, and where to find them in the code

**1. The `.proto` file is the contract** (`proto/*.proto`).
Server and clients load the same file, so both sides know the method names and message shapes.
Field numbers (`= 1`, `= 2`) are what go on the wire. Field names don't.

**2. A client is a long-lived object.**
`new userProto.UserService('localhost:50051', creds)` opens one HTTP/2 connection.
All calls are multiplexed over that connection. Create the client once, not once per request.

**3. RPC types.** This demo uses two of the four:
| Type | Example here | Server side | Client side |
|---|---|---|---|
| Unary | `GetUser`, `CreateOrder` | `(call, callback)` → `callback(err, res)` | `client.M(req, cb)` |
| Server streaming | `ListUsers` | `call.write(msg)` … `call.end()` | `stream.on('data')` |
| Client streaming | — | `call.on('data')`, then callback | `call.write()` … `call.end()` |
| Bidirectional | — | both sides read and write a stream | |

**4. Metadata = headers.** The gateway sets `x-request-id`. Order Service **forwards** its incoming
`call.metadata` when it calls User Service. That's *context propagation*, the same idea real
tracing systems (OpenTelemetry) use. Auth tokens usually travel this way too.

**5. Deadlines.** Every client call passes `{ deadline }`. Without one, a hung downstream service
makes every caller hang forever. If the deadline passes, you get `DEADLINE_EXCEEDED`.

**6. Status codes, not HTTP codes.** gRPC errors carry a `code` such as `NOT_FOUND`, `ALREADY_EXISTS`,
`INVALID_ARGUMENT` or `UNAVAILABLE`. Services pass these along. Order Service passes user-service's
`NOT_FOUND` through unchanged. The gateway maps them to HTTP (404, 409, 400, 503) at the edge.

**7. Each service owns its data.** Both tables are in one database to keep setup simple.
But Order Service never reads `users` directly. If you later split them into two databases,
no code changes are needed.

## Service-to-service authentication & authorization

Every service checks two things on every call:

| Question | Name | Fails with | Where |
|---|---|---|---|
| *Who is calling?* | **Authentication** | `UNAUTHENTICATED` | `authenticate()` in `shared/auth.js` |
| *May they call this method?* | **Authorization** | `PERMISSION_DENIED` | `ACCESS_POLICY` in each `server.js` |

### How a call gets authenticated

```
order-service                                         user-service
─────────────                                         ────────────
client interceptor:                                   server interceptor:
  jwt.sign({                                            1. read "authorization" metadata
    iss: "order-service",  ← who I am                   2. iss = "order-service" → load
    aud: "user-service",   ← who it's for                  keys/order-service.public.pem
    exp: now + 5min                                     3. verify signature + exp + aud
  }, order-service.private.pem)                         4. policy["/user.UserService/GetUser"]
                                                           includes "order-service"? → ALLOW
  metadata: authorization: Bearer eyJ...  ─────────▶    5. run the GetUser handler
```

- **Each service has its own key pair.** It signs with its **private** key (only it has that).
  Others verify with its **public** key. A shared secret would be simpler, but then every service
  could forge tokens for every other service.
- **`aud` (audience)** stops a token meant for order-service from being replayed against user-service.
- **Short expiry (5 min)** limits how long a stolen token is useful. The client caches its token
  and re-signs it shortly before it expires.
- **`algorithms: ['RS256']` is pinned** on verify. Never let the token choose its own algorithm.

### The policy is default-deny, least privilege

```js
// user-service/server.js
const ACCESS_POLICY = {
  '/user.UserService/CreateUser': ['gateway'],
  '/user.UserService/GetUser':    ['gateway', 'order-service'], // order-service only needs this
  '/user.UserService/ListUsers':  ['gateway'],
};
```
If you add a new RPC and forget to add it to the policy, **nobody** can call it. That's the safe failure mode.

### Interceptors = gRPC middleware

- **Client interceptor** (`clientAuthInterceptor`) is set when the client is created.
  It adds the token to *every* outgoing call, so the business code never deals with tokens.
- **Server interceptor** (`serverAuthInterceptor`) is set in `new grpc.Server({ interceptors })`.
  It runs *before* the handler. If it calls `call.sendStatus(error)`, the handler never runs.
  On success it sets `x-authenticated-caller` in the metadata, which handlers can read.

### Don't forward credentials

Order Service used to forward all of its incoming metadata to user-service. With auth, that metadata
includes the **gateway's** token. Now `outgoingMetadata()` copies only `x-request-id`, and the
client interceptor adds order-service's own token. Each hop proves its *own* identity.

### Errors at the boundary

If user-service rejects order-service (bad keys or policy), that's a misconfiguration inside the
system, not the end user's fault. So order-service reports `INTERNAL` (HTTP 500) and doesn't pass a
confusing 401/403 up to the browser.

### Try to break it: `npm run auth:demo`

This calls user-service directly with hand-made tokens:

```
▶ No token at all                                  -> UNAUTHENTICATED: missing bearer token
▶ Forged: claims to be "gateway", attacker's key   -> UNAUTHENTICATED: invalid signature
▶ Unknown service "billing-service"                -> UNAUTHENTICATED: unknown service
▶ Gateway token meant for order-service            -> UNAUTHENTICATED: jwt audience invalid
▶ Expired gateway token                            -> UNAUTHENTICATED: jwt expired
▶ order-service calls ListUsers                    -> PERMISSION_DENIED
▶ order-service calls CreateUser                   -> PERMISSION_DENIED
▶ order-service calls GetUser                      -> OK
▶ gateway calls ListUsers                          -> OK
```

**Experiments:** remove `'order-service'` from `GetUser` in the user-service policy and create an
order. You'll get a 500, and the logs show `DENY order-service -> /user.UserService/GetUser`.
Or delete `keys/order-service.public.pem` and restart user-service. Order Service is now
an "unknown service".

### What this does NOT cover yet

- **Transport encryption.** Connections are still plaintext (`createInsecure`). Anyone on the
  network could read a token and replay it until it expires. In production, add **TLS**, or
  **mTLS**, where both sides present certificates and identity is proven at the connection level.
  Service meshes (Istio, Linkerd) do mTLS for you.
- **End-user identity.** This proves *which service* is calling, not *which human*. The next step
  is user login at the gateway, then passing the user's identity downstream next to the service token.

## Why gRPC instead of REST between services?

- **Typed contract.** A mismatched field is caught by the schema, not at 2am.
- **Binary + HTTP/2.** Smaller payloads, one multiplexed connection, and streaming built in.
- **Codegen.** The same `.proto` produces clients in Go, Python, Java and more, so services in different languages can talk.

REST/JSON is still the norm at the **edge** (browsers, public APIs). That's why the gateway exists.

## Ideas to extend it (good practice)

- Add a `DeleteUser` RPC: edit the proto, add a handler, add a route.
- Add a **client-streaming** RPC, e.g. `BulkCreateUsers(stream CreateUserRequest) returns (Summary)`.
- Make User Service slow (`await new Promise(r => setTimeout(r, 3000))`) and watch the 2s deadline fire.
- Add TLS to the gRPC connections (`grpc.credentials.createSsl` / `grpc.ServerCredentials.createSsl`).
- Call the services directly with [grpcurl](https://github.com/fullstorydev/grpcurl) or Postman's gRPC mode, skipping the gateway:
  `grpcurl -plaintext -import-path proto -proto user.proto -d '{"id":1}' localhost:50051 user.UserService/GetUser`
