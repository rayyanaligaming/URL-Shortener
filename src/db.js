const { Pool } = require('pg');
const config = require('./config');

// A pool reuses connections instead of opening a new one per request.
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

pool.on('error', (err) => console.error('Unexpected Postgres error', err));

module.exports = pool;