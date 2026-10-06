// Loads a .proto file at runtime and turns it into JavaScript objects.
//
// There are two ways to use protobuf in Node:
//   1. Generate code ahead of time with `protoc` (static codegen)
//   2. Load the .proto at runtime with @grpc/proto-loader (dynamic)  <-- we use this
// Dynamic loading is simpler for learning: edit the .proto, restart, done.

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

function loadProto(fileName) {
  const packageDefinition = protoLoader.loadSync(
    path.join(__dirname, '..', 'proto', fileName),
    {
      keepCase: true, // keep snake_case field names (user_id) instead of userId
      longs: String,
      enums: String,
      defaults: true, // include fields with default values (0, "") in objects
      oneofs: true,
    }
  );
  // Returns an object like { user: { UserService: <constructor>, User: ... } }
  return grpc.loadPackageDefinition(packageDefinition);
}

module.exports = { loadProto, grpc };
