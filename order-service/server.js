// ============================================================================
// ORDER SERVICE — gRPC server (port 50052) AND gRPC client of User Service
//
// This is where service-to-service communication happens:
//
//   gateway --CreateOrder--> order-service --GetUser--> user-service
//                                  |                         |
//                              orders table              users table
//
// Before saving an order, we call User Service to make sure the user exists.
// ============================================================================
require('dotenv').config();
const { loadProto, grpc } = require('../shared/proto-loader');
const pool = require('../shared/db');
const { serverAuthInterceptor, clientAuthInterceptor } = require('../shared/auth');

const orderProto = loadProto('order.proto').order;
const userProto = loadProto('user.proto').user; // we need the User contract to call it

const PORT = process.env.ORDER_SERVICE_PORT || 50052;
const USER_SERVICE_ADDR = process.env.USER_SERVICE_ADDR || 'localhost:50051';
const SERVICE_NAME = 'order-service';

// Who may call US. Only the gateway talks to order-service.
const ACCESS_POLICY = {
  '/order.OrderService/CreateOrder':     ['gateway'],
  '/order.OrderService/GetOrdersByUser': ['gateway'],
};

// ---------------------------------------------------------------------------
// The gRPC CLIENT for User Service.
// Created once and reused: under the hood it keeps one HTTP/2 connection open
// and multiplexes all calls over it. You do NOT open a connection per call.
//
// The interceptor signs every outgoing call as "order-service" for the
// audience "user-service". Calling code doesn't have to think about auth.
// ---------------------------------------------------------------------------
const userClient = new userProto.UserService(USER_SERVICE_ADDR, grpc.credentials.createInsecure(), {
  interceptors: [clientAuthInterceptor(SERVICE_NAME, 'user-service')],
});

// Build metadata for an outgoing call from an incoming one.
// Forward ONLY what downstream needs (the request id). Don't forward the whole
// incoming metadata: it holds the gateway's token, and credentials should
// never be passed along to the next hop. We sign our own.
function outgoingMetadata(call) {
  const md = new grpc.Metadata();
  md.set('x-request-id', call.metadata.get('x-request-id')[0] || '-');
  return md;
}

// Small helper that wraps the callback-style client call in a Promise.
function getUser(id, metadata) {
  return new Promise((resolve, reject) => {
    // Deadline: "give up if user-service hasn't answered in 2 seconds".
    // Always set deadlines on service-to-service calls so one slow service
    // can't make every caller hang forever.
    const deadline = new Date(Date.now() + 2000);
    userClient.GetUser({ id }, metadata, { deadline }, (err, user) =>
      err ? reject(err) : resolve(user)
    );
  });
}

function toOrder(row, userName) {
  return {
    id: row.id,
    user_id: row.user_id,
    product: row.product,
    quantity: row.quantity,
    price: Number(row.price),
    created_at: row.created_at.toISOString(),
    user_name: userName,
  };
}

const handlers = {
  async CreateOrder(call, callback) {
    const { user_id, product, quantity, price } = call.request;
    const reqId = call.metadata.get('x-request-id')[0] || '-';
    console.log(`[order-service] [${reqId}] CreateOrder`, call.request);

    if (!product || quantity <= 0) {
      return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'product and a positive quantity are required' });
    }

    // ---- SERVICE-TO-SERVICE CALL -------------------------------------------
    // Pass the request id along so user-service logs show the same id.
    // This is "context propagation".
    let user;
    try {
      console.log(`[order-service] [${reqId}]   -> calling user-service GetUser(${user_id})`);
      user = await getUser(user_id, outgoingMetadata(call));
      console.log(`[order-service] [${reqId}]   <- user-service replied: ${user.name}`);
    } catch (err) {
      console.log(`[order-service] [${reqId}]   <- user-service error: ${grpc.status[err.code]} ${err.details}`);
      return callback({ code: mapUserServiceError(err), message: `user check failed: ${err.details}` });
    }
    // ------------------------------------------------------------------------

    try {                       
      const { rows } = await pool.query(
        'INSERT INTO orders (user_id, product, quantity, price) VALUES ($1, $2, $3, $4) RETURNING *',
        [user_id, product, quantity, price]
      );
      callback(null, toOrder(rows[0], user.name));
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: err.message });
    }
  },

  async GetOrdersByUser(call, callback) {
    const { user_id } = call.request;
    const reqId = call.metadata.get('x-request-id')[0] || '-';
    console.log(`[order-service] [${reqId}] GetOrdersByUser user_id=${user_id}`);

    // Again ask user-service, this time to enrich the result with the name.
    let user;
    try {
      user = await getUser(user_id, outgoingMetadata(call));
    } catch (err) {
      return callback({ code: mapUserServiceError(err), message: `user lookup failed: ${err.details}` });
    }

    try {
      const { rows } = await pool.query(
        'SELECT * FROM orders WHERE user_id = $1 ORDER BY id',
        [user_id]
      );
      // `orders` matches the `repeated Order orders = 1;` field in the proto.
      callback(null, { orders: rows.map((r) => toOrder(r, user.name)) });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: err.message });
    }
  },
};

// Decide what OUR caller should see when user-service fails.
//  - NOT_FOUND: a real answer about the data, pass it through.
//  - UNAVAILABLE / DEADLINE_EXCEEDED: user-service is down or slow.
//  - anything else, including UNAUTHENTICATED / PERMISSION_DENIED: that's OUR
//    problem (bad keys or policy), not the end user's, so report INTERNAL.
//    Passing it through would turn into a confusing 401/403 for the user.
function mapUserServiceError(err) {
  switch (err.code) {
    case grpc.status.NOT_FOUND:
      return grpc.status.NOT_FOUND;
    case grpc.status.UNAVAILABLE:
    case grpc.status.DEADLINE_EXCEEDED:
      return grpc.status.UNAVAILABLE;
    default:
      return grpc.status.INTERNAL;
  }
}

const server = new grpc.Server({
  interceptors: [serverAuthInterceptor(SERVICE_NAME, ACCESS_POLICY)],
});
server.addService(orderProto.OrderService.service, handlers);

server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[order-service] gRPC server listening on :${PORT} (talks to user-service at ${USER_SERVICE_ADDR})`);
});
