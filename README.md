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
npm run db:init             # creates the users + orders tables
npm start                   # starts all 3 services with colored logs
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

## Why gRPC instead of REST between services?

- **Typed contract.** A mismatched field is caught by the schema, not at 2am.
- **Binary + HTTP/2.** Smaller payloads, one multiplexed connection, and streaming built in.
- **Codegen.** The same `.proto` produces clients in Go, Python, Java and more, so services in different languages can talk.

REST/JSON is still the norm at the **edge** (browsers, public APIs). That's why the gateway exists.

## Ideas to extend it (good practice)

- Add a `DeleteUser` RPC: edit the proto, add a handler, add a route.
- Add a **client-streaming** RPC, e.g. `BulkCreateUsers(stream CreateUserRequest) returns (Summary)`.
- Make User Service slow (`await new Promise(r => setTimeout(r, 3000))`) and watch the 2s deadline fire.
- Check an `authorization` metadata key in a server handler and return `UNAUTHENTICATED`.
- Call the services directly with [grpcurl](https://github.com/fullstorydev/grpcurl) or Postman's gRPC mode, skipping the gateway:
  `grpcurl -plaintext -import-path proto -proto user.proto -d '{"id":1}' localhost:50051 user.UserService/GetUser`
