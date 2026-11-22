/**
 * Non-blocking audit logging service.
 *
 * All methods catch errors internally and log them rather than
 * propagating — audit failures must never break the main operation.
 */
const crypto = require('crypto');
const AuditLog = require('../models/AuditLog.model');
const logger = require('../utils/logger');

const REDACTED = '[REDACTED]';

/**
 * Sensitive metadata keys are matched after normalization: lowercase and with
 * every non-alphanumeric character removed. That makes `Authorization`,
 * `authorization`, `private_key`, `private-key` and `privateKey` all resolve
 * to the same policy entry, so a casing or separator variant cannot bypass
 * redaction. The original key is preserved in the stored metadata; only its
 * value is replaced.
 */
const SENSITIVE_KEY_NAMES = new Set([
  'password',
  'secret',
  'signature',
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'seed',
  'mnemonic',
  'pin',
]);

const normalizeSensitiveKey = (key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

const isSensitiveKey = (key) => SENSITIVE_KEY_NAMES.has(normalizeSensitiveKey(key));

const normalizeValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeValue(value[key]);
        return acc;
      }, {});
  }

  return value;
};

const redactSensitive = (value) => {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((acc, key) => {
      if (isSensitiveKey(key)) {
        acc[key] = REDACTED;
      } else {
        acc[key] = redactSensitive(value[key]);
      }
      return acc;
    }, {});
  }

  return value;
};

const serializeForHash = (value) => JSON.stringify(normalizeValue(value));

/**
 * Hash sensitive payload data before storing.
 * @param {*} payload
 * @returns {string} SHA-256 hex digest
 */
const hashPayload = (payload) => {
  const str = typeof payload === 'string' ? payload : serializeForHash(payload);
  return crypto.createHash('sha256').update(str).digest('hex');
};

/**
 * Record an audit log entry. Non-blocking — errors are caught and logged.
 *
 * @param {object} params
 * @param {string} params.actor - Who performed the action
 * @param {string} params.action - Action identifier (e.g. 'wallet.deposit')
 * @param {string} params.target - Target resource identifier
 * @param {*} [params.payload] - Sensitive data to hash (not stored raw)
 * @param {string} [params.outcome='success'] - 'success' or 'failure'
 * @param {object} [params.metadata] - Additional non-sensitive context
 */
const log = async ({ actor, action, target, payload, outcome = 'success', metadata }) => {
  try {
    const entry = {
      actor: String(actor),
      action,
      target: String(target),
      outcome,
    };

    if (payload) {
      entry.payload_hash = hashPayload(payload);
    }

    if (metadata) {
      entry.metadata = JSON.stringify(redactSensitive(metadata));
    }

    await AuditLog.create(entry);
  } catch (error) {
    logger.error(`[AuditService] Failed to write audit log: ${error.message}`);
  }
};

const list = async ({ actor, action, limit = 50, allowGlobal = false } = {}) => {
  try {
    return await AuditLog.findAll({ actor, action, limit, allowGlobal });
  } catch (error) {
    logger.error(`[AuditService] Failed to read audit log: ${error.message}`);
    throw error;
  }
};

module.exports = {
  log,
  list,
  hashPayload,
  normalizeValue,
  redactSensitive,
};
