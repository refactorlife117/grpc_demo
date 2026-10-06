// Run once: `npm run db:init` — creates the tables from schema.sql
const fs = require('fs');
const path = require('path');
const pool = require('../shared/db');

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Tables created (users, orders).');
  } catch (err) {
    console.error('DB init failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
