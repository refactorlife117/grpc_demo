// ============================================================================
// API GATEWAY — Express REST API (port 3000) that is a gRPC CLIENT
//
// Browsers and curl speak HTTP/JSON, not gRPC. So the usual pattern is:
//   outside world --HTTP/JSON--> gateway --gRPC--> internal services
// The gateway translates JSON -> gRPC request, and gRPC status -> HTTP status.
// ============================================================================
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { loadProto, grpc } = require('../shared/proto-loader');

const userProto = loadProto('user.proto').user;
const orderProto = loadProto('order.proto').order;

const PORT = process.env.GATEWAY_PORT || 3000;
const USER_SERVICE_ADDR = process.env.USER_SERVICE_ADDR || 'localhost:50051';
const ORDER_SERVICE_ADDR = process.env.ORDER_SERVICE_ADDR || 'localhost:50052';

// One long-lived client per service.
const userClient = new userProto.UserService(USER_SERVICE_ADDR, grpc.credentials.createInsecure());
const orderClient = new orderProto.OrderService(ORDER_SERVICE_ADDR, grpc.credentials.createInsecure());

// Turn a callback-style unary gRPC call into a Promise, attaching metadata.
function call(client, method, request, reqId) {
  const metadata = new grpc.Metadata();
  metadata.set('x-request-id', reqId);
  const deadline = new Date(Date.now() + 5000);
  return new Promise((resolve, reject) => {
    client[method](request, metadata, { deadline }, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

// gRPC has its own status codes. Map the common ones to HTTP.
const GRPC_TO_HTTP = {
  [grpc.status.INVALID_ARGUMENT]: 400,
  [grpc.status.NOT_FOUND]: 404,
  [grpc.status.ALREADY_EXISTS]: 409,
  [grpc.status.DEADLINE_EXCEEDED]: 504,
  [grpc.status.UNAVAILABLE]: 503,
};

function sendGrpcError(res, err) {
  const http = GRPC_TO_HTTP[err.code] || 500;
  res.status(http).json({
    error: err.details || err.message,
    grpc_status: grpc.status[err.code], // e.g. "NOT_FOUND" (the enum maps number -> name too)
  });
}

const app = express();
app.use(express.json());

// Give every incoming HTTP request an id; it travels through all gRPC hops.
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  console.log(`[gateway] [${req.id}] ${req.method} ${req.url}`);
  next();
});

// ---- Users -----------------------------------------------------------------
app.post('/users', async (req, res) => {
  try {
    res.status(201).json(await call(userClient, 'CreateUser', req.body, req.id));
  } catch (err) {
    sendGrpcError(res, err);
  }
});

app.get('/users/:id', async (req, res) => {
  try {
    res.json(await call(userClient, 'GetUser', { id: Number(req.params.id) }, req.id));
  } catch (err) {
    sendGrpcError(res, err);
  }
});

// Consuming a SERVER-STREAMING rpc: no callback; you get a readable stream
// and receive a 'data' event per message the server writes.
app.get('/users', (req, res) => {
  const metadata = new grpc.Metadata();
  metadata.set('x-request-id', req.id);

  const users = [];
  const stream = userClient.ListUsers({}, metadata);
  stream.on('data', (user) => {
    console.log(`[gateway] [${req.id}]   stream message: user ${user.id}`);
    users.push(user);
  });
  stream.on('end', () => res.json(users));
  stream.on('error', (err) => sendGrpcError(res, err));
});

// ---- Orders ----------------------------------------------------------------
// This one triggers the chain: gateway -> order-service -> user-service
app.post('/orders', async (req, res) => {
  try {
    res.status(201).json(await call(orderClient, 'CreateOrder', req.body, req.id));
  } catch (err) {
    sendGrpcError(res, err);
  }
});

app.get('/users/:id/orders', async (req, res) => {
  try {
    const result = await call(orderClient, 'GetOrdersByUser', { user_id: Number(req.params.id) }, req.id);
    res.json(result.orders);
  } catch (err) {
    sendGrpcError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`[gateway] HTTP server on http://localhost:${PORT}`);
});
