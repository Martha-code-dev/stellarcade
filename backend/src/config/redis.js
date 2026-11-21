const { createClient } = require('redis');
const logger = require('./logger');

const isTest = process.env.NODE_ENV === 'test';

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  // Without this, node-redis queues commands indefinitely while
  // disconnected instead of rejecting them — rate-limit.middleware.js's
  // fail-open catch block never runs, and every rate-limited request hangs
  // forever instead of failing open when Redis is unreachable.
  disableOfflineQueue: true,
  // There is no Redis in the test environment. Retrying forever would leave a
  // reconnection timer open and keep the Jest worker alive after the tests
  // finish, so fail the connection immediately instead.
  ...(isTest ? { reconnectStrategy: false } : {}),
});

client.on('error', (err) => {
  if (!isTest) {
    logger.error('Redis Client Error', err);
  }
});
client.on('connect', () => {
  if (!isTest) {
    logger.info('Redis connected successfully');
  }
});

let connectPromise = Promise.resolve();
let disconnectPromise = null;

/** Connect the client we own. Tests stay disconnected unless they opt in. */
function connectRedis() {
  if (isTest || client.isOpen || client.isReady) {
    return connectPromise;
  }
  connectPromise = client.connect().catch((err) => {
    logger.error('Redis connection failed:', err);
  });
  return connectPromise;
}

/** Close the client we own. Safe to call repeatedly and in any state. */
function disconnectRedis() {
  if (disconnectPromise) {
    return disconnectPromise;
  }
  if (!client.isOpen && !client.isReady) {
    disconnectPromise = Promise.resolve();
    return disconnectPromise;
  }
  disconnectPromise = client.quit().catch((err) => {
    logger.error('Redis shutdown failed:', err);
  });
  return disconnectPromise;
}

// Production connects at startup; tests own the connection explicitly so the
// runner is not kept alive by a socket that no test uses.
connectRedis();

module.exports = {
  client,
  connectPromise,
  connectRedis,
  disconnectRedis,
};
