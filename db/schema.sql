-- In a real microservice setup each service would usually own its own
-- database. Here both tables live in one database to keep setup simple,
-- but notice: Order Service never queries the users table directly.
-- It asks User Service over gRPC instead.

CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL, -- no foreign key on purpose: the services are separate
  product    TEXT NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  price      NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
