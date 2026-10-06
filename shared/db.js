// A single Postgres connection pool, configured from DATABASE_URL in .env
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = pool;
