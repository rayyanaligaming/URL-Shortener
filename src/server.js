const app = require('./app');
const config = require('./config');
const pool = require('./db');
const redis = require('./redis');
const { startFlusher, stopFlusher } = require('./analytics');

startFlusher();

const server = app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});

// Graceful shutdown: finish in-flight requests, then close connections.
async function shutdown() {
  console.log('Shutting down...');
  server.close(async () => {
    await stopFlusher();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);