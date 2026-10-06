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

const orderProto = loadProto('order.proto').order;
const userProto = loadProto('user.proto').user; // we need the User contract to call it

const PORT = process.env.ORDER_SERVICE_PORT || 50052;
const USER_SERVICE_ADDR = process.env.USER_SERVICE_ADDR || 'localhost:50051';

// ---------------------------------------------------------------------------
// The gRPC CLIENT for User Service.
// Created once and reused: under the hood it keeps one HTTP/2 connection open
// and multiplexes all calls over it. You do NOT open a connection per call.
// ---------------------------------------------------------------------------
const userClient = new userProto.UserService(USER_SERVICE_ADDR, grpc.credentials.createInsecure());

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
    // Forward the incoming metadata (it contains x-request-id) so the
    // user-service logs show the same id. This is "context propagation".
    let user;
    try {
      console.log(`[order-service] [${reqId}]   -> calling user-service GetUser(${user_id})`);
      user = await getUser(user_id, call.metadata);
      console.log(`[order-service] [${reqId}]   <- user-service replied: ${user.name}`);
    } catch (err) {
      console.log(`[order-service] [${reqId}]   <- user-service error: ${err.code} ${err.details}`);
      // Pass NOT_FOUND through as-is; anything else means user-service is
      // down/broken, which is UNAVAILABLE from our caller's point of view.
      const code = err.code === grpc.status.NOT_FOUND ? grpc.status.NOT_FOUND : grpc.status.UNAVAILABLE;
      return callback({ code, message: `user check failed: ${err.details}` });
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

    try {
      // Again ask user-service, this time to enrich the result with the name.
      const user = await getUser(user_id, call.metadata);
      const { rows } = await pool.query(
        'SELECT * FROM orders WHERE user_id = $1 ORDER BY id',
        [user_id]
      );
      // `orders` matches the `repeated Order orders = 1;` field in the proto.
      callback(null, { orders: rows.map((r) => toOrder(r, user.name)) });
    } catch (err) {
      callback({ code: err.code ?? grpc.status.INTERNAL, message: err.details || err.message });
    }
  },
};

const server = new grpc.Server();
server.addService(orderProto.OrderService.service, handlers);

server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[order-service] gRPC server listening on :${PORT} (talks to user-service at ${USER_SERVICE_ADDR})`);
});
