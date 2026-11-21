/**
 * Base model for Users.
 *
 * Provides an interface for user-related database operations.
 */
const db = require('../config/database');
const logger = require('../utils/logger');

const USERNAME_UNIQUE_INDEX = 'users_username_lower_unique';
const WALLET_UNIQUE_CONSTRAINT = 'users_wallet_address_unique';

function isUniqueViolation(error) {
  if (!error) return false;
  const code = error.code || error.errno;
  return code === '23505' || (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT'));
}

function conflictDetail(error) {
  return [error && error.constraint, error && error.message].filter(Boolean).join(' ');
}

function isUsernameConflict(error) {
  if (!isUniqueViolation(error)) return false;
  const detail = conflictDetail(error);
  return detail.includes(USERNAME_UNIQUE_INDEX) || detail.includes('users.username');
}

function isWalletConflict(error) {
  if (!isUniqueViolation(error)) return false;
  const detail = conflictDetail(error);
  return detail.includes(WALLET_UNIQUE_CONSTRAINT) || detail.includes('users.wallet_address');
}

function usernameTakenError() {
  const error = new Error('That username is already taken.');
  error.statusCode = 409;
  error.code = 'USERNAME_TAKEN';
  return error;
}

function reportsUsernameConflict(error) {
  if (!isUsernameConflict(error)) return false;
  logger.error('Error in User username reservation:', error);
  return true;
}

const User = {
  /**
   * Find a user by their Stellar wallet address.
   * @param {string} address
   */
  async findByWallet(address, database = db) {
    try {
      return await database('users').where({ wallet_address: address }).first();
    } catch (error) {
      logger.error('Error in User.findByWallet:', error);
      throw error;
    }
  },

  /**
   * Create a new user profile.
   *
   * Wallet uniqueness is resolved by an atomic upsert so two first writes for
   * the same wallet cannot create extra profiles. Username uniqueness is
   * resolved by the database's case-insensitive index and surfaced as a stable
   * 409 rather than a raw constraint error.
   *
   * @param {object} userData
   */
  async create(userData, database = db) {
    try {
      const users = await database('users').insert(userData).returning('*');
      return users[0];
    } catch (error) {
      if (isUsernameConflict(error)) throw usernameTakenError();
      if (isWalletConflict(error)) {
        const existing = await this.findByWallet(userData.wallet_address, database);
        if (existing) return existing;
      }
      logger.error('Error in User.create:', error);
      throw error;
    }
  },

  /**
   * Reserve a wallet on first login without inventing a public username.
   * Concurrent logins all receive the same row, and extra rows are impossible
   * because the insert depends on the wallet's unique constraint.
   *
   * @param {string} address
   */
  async reserveWallet(address, database = db) {
    try {
      const users = await database('users')
        .insert({
          wallet_address: address,
          created_at: database.fn.now(),
          updated_at: database.fn.now(),
        })
        .onConflict('wallet_address')
        .ignore()
        .returning('*');
      if (users[0]) return users[0];
    } catch (error) {
      if (!isWalletConflict(error)) {
        logger.error('Error in User.reserveWallet:', error);
        throw error;
      }
    }

    return this.findByWallet(address, database);
  },

  /**
   * Find a user by internal id.
   * @param {number|string} id
   */
  async findById(id, database = db) {
    try {
      return await database('users').where({ id }).first();
    } catch (error) {
      logger.error('Error in User.findById:', error);
      throw error;
    }
  },

  /**
   * Update fields on an existing user, found by wallet address.
   * @param {string} address
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async updateByWallet(address, patch, database = db) {
    try {
      const rows = await database('users')
        .where({ wallet_address: address })
        .update({ ...patch, updated_at: database.fn.now() })
        .returning('*');
      return rows[0] || null;
    } catch (error) {
      if (
        Object.prototype.hasOwnProperty.call(patch, 'username') &&
        reportsUsernameConflict(error)
      ) {
        throw usernameTakenError();
      }
      logger.error('Error in User.updateByWallet:', error);
      throw error;
    }
  },
};

module.exports = User;
