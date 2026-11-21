/**
 * Model for audit log entries.
 */
const db = require('../config/database');
const logger = require('../utils/logger');

const AuditLog = {
  /**
   * Insert a new audit log entry.
   * @param {object} entry
   * @param {string} entry.actor - Who performed the action (user ID or system)
   * @param {string} entry.action - What was done (e.g. 'wallet.deposit')
   * @param {string} entry.target - What was acted upon (e.g. resource ID)
   * @param {string} [entry.payload_hash] - SHA-256 hash of sensitive payload
   * @param {string} [entry.outcome] - 'success' or 'failure'
   * @param {object} [entry.metadata] - Additional non-sensitive context
   */
  async create(entry) {
    try {
      const normalizedEntry = {
        ...entry,
        metadata:
          entry.metadata && typeof entry.metadata !== 'string'
            ? JSON.stringify(entry.metadata)
            : entry.metadata,
      };
      const rows = await db('audit_logs').insert(normalizedEntry).returning('*');
      return rows[0];
    } catch (error) {
      logger.error('Error in AuditLog.create:', error);
      throw error;
    }
  },

  /**
   * Find audit log entries by actor.
   * @param {string} actor
   * @param {number} [limit=50]
   */
  async findByActor(actor, limit = 50) {
    try {
      return await db('audit_logs').where({ actor }).orderBy('created_at', 'desc').limit(limit);
    } catch (error) {
      logger.error('Error in AuditLog.findByActor:', error);
      throw error;
    }
  },

  /**
   * Find audit log entries by action type.
   * @param {string} action
   * @param {number} [limit=50]
   */
  async findByAction(action, limit = 50) {
    try {
      return await db('audit_logs').where({ action }).orderBy('created_at', 'desc').limit(limit);
    } catch (error) {
      logger.error('Error in AuditLog.findByAction:', error);
      throw error;
    }
  },

  /**
   * Find audit log entries with optional actor/action filters. An unscoped
   * read is only possible when the caller has explicitly authorized it via
   * `allowGlobal`; ordinary reads must always name an actor.
   *
   * @param {Object} params
   * @param {string} [params.actor]
   * @param {string} [params.action]
   * @param {number} [params.limit=50]
   * @param {boolean} [params.allowGlobal=false]
   */
  async findAll({ actor, action, limit = 50, allowGlobal = false } = {}) {
    if (!actor && !allowGlobal) {
      const error = new Error('An actor is required to read audit logs.');
      error.statusCode = 400;
      error.code = 'AUDIT_ACTOR_REQUIRED';
      throw error;
    }

    try {
      const query = db('audit_logs').orderBy('created_at', 'desc');

      if (actor) {
        query.where({ actor });
      }

      if (action) {
        query.where({ action });
      }

      return await query.limit(limit);
    } catch (error) {
      logger.error('Error in AuditLog.findAll:', error);
      throw error;
    }
  },
};

module.exports = AuditLog;
