// ============================================================================
// USER SERVICE — a pure gRPC server (port 50051)
//
// It owns the `users` table. Anyone who needs user data (the gateway, the
// order service) must ask this service over gRPC. Nobody else touches the table.
// ============================================================================
require('dotenv').config();
const { loadProto, grpc } = require('../shared/proto-loader');
const pool = require('../shared/db');

const userProto = loadProto('user.proto').user;
const PORT = process.env.USER_SERVICE_PORT || 50051;

// Metadata = gRPC's version of HTTP headers. We use it to pass a request id
// along the chain so you can follow ONE request through all the service logs.
function requestId(call) {
  return call.metadata.get('x-request-id')[0] || '-';
}

function toUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    created_at: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Handlers. For a UNARY rpc the signature is (call, callback):
//   call.request  -> the decoded request message (a plain JS object)
//   callback(err, response)
// To return an error you pass an object with a gRPC status `code`.
// ---------------------------------------------------------------------------
const handlers = {
  async CreateUser(call, callback) {
    const { name, email } = call.request;
    console.log(`[user-service] [${requestId(call)}] CreateUser`, call.request);

    if (!name || !email) {
      return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'name and email are required' });
    }
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
        [name, email]
      );
      callback(null, toUser(rows[0]));
    } catch (err) {
      if (err.code === '23505') { // Postgres "unique violation"
        return callback({ code: grpc.status.ALREADY_EXISTS, message: `email ${email} already exists` });
      }
      callback({ code: grpc.status.INTERNAL, message: err.message });
    }
  },

  async GetUser(call, callback) {
    const { id } = call.request;
    console.log(`[user-service] [${requestId(call)}] GetUser id=${id}`);
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      if (rows.length === 0) {
        return callback({ code: grpc.status.NOT_FOUND, message: `user ${id} not found` });
      }
      callback(null, toUser(rows[0]));
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: err.message });
    }
  },

  // For a SERVER-STREAMING rpc there is no callback. Instead, `call` is a
  // writable stream: call.write(msg) sends one message, call.end() finishes.
  async ListUsers(call) {
    console.log(`[user-service] [${requestId(call)}] ListUsers (streaming)`);
    try {
      const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
      for (const row of rows) {
        call.write(toUser(row)); // each write = one message on the wire
      }
      call.end();
    } catch (err) {
      call.destroy({ code: grpc.status.INTERNAL, message: err.message });
    }
  },
};

// ---------------------------------------------------------------------------
// Start the server: register the handlers against the service definition,
// bind a port, done. createInsecure() = plaintext, fine for local learning.
// In production you'd use grpc.ServerCredentials.createSsl(...) for TLS.
// ---------------------------------------------------------------------------
const server = new grpc.Server();
server.addService(userProto.UserService.service, handlers);

server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[user-service] gRPC server listening on :${PORT}`);
});
