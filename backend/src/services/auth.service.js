/**
 * Wallet-signature login. Proves control of a Stellar address without ever
 * seeing a secret key: the client signs a server-issued challenge with its
 * wallet, the server verifies that signature against the claimed address,
 * then issues a JWT. Challenges live in Redis so every backend instance
 * sees the same pending logins and a challenge can be consumed exactly once.
 */
const { randomBytes, createHash } = require('crypto');
const jwt = require('jsonwebtoken');
const { Keypair } = require('@stellar/stellar-sdk');
const { client } = require('../config/redis');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_SECONDS = Math.ceil(CHALLENGE_TTL_MS / 1000);
const CHALLENGE_KEY_PREFIX = 'auth:login-challenge:';
const JWT_EXPIRES_IN = '7d';

class ChallengeNotFoundError extends Error {
  constructor() {
    super('No pending login challenge for this address. Request a new one.');
    this.name = 'ChallengeNotFoundError';
    this.statusCode = 400;
    this.code = 'CHALLENGE_NOT_FOUND';
  }
}

class ChallengeExpiredError extends Error {
  constructor() {
    super('Login challenge expired. Request a new one.');
    this.name = 'ChallengeExpiredError';
    this.statusCode = 400;
    this.code = 'CHALLENGE_EXPIRED';
  }
}

class InvalidAddressError extends Error {
  constructor() {
    super('A valid Stellar public key (G...) is required.');
    this.name = 'InvalidAddressError';
    this.statusCode = 400;
    this.code = 'INVALID_ADDRESS';
  }
}

class InvalidSignatureError extends Error {
  constructor() {
    super('Signature does not verify against the given address.');
    this.name = 'InvalidSignatureError';
    this.statusCode = 401;
    this.code = 'INVALID_SIGNATURE';
  }
}

class AuthNotConfiguredError extends Error {
  constructor() {
    super('Login is not available: JWT_SECRET is not configured.');
    this.name = 'AuthNotConfiguredError';
    this.statusCode = 503;
    this.code = 'AUTH_NOT_CONFIGURED';
  }
}

/**
 * Wallets (Freighter et al.) that implement signMessage don't sign raw
 * bytes, they sign sha256("Stellar Signed Message:\n" + message), the
 * same convention as SEP-53 and Ethereum's personal_sign.
 */
function stellarSignedMessageHash(message) {
  return createHash('sha256').update(`Stellar Signed Message:\n${message}`, 'utf8').digest();
}

function assertValidAddress(address) {
  if (typeof address !== 'string') {
    throw new InvalidAddressError();
  }
  try {
    Keypair.fromPublicKey(address);
  } catch {
    throw new InvalidAddressError();
  }
}

function challengeKey(address) {
  return `${CHALLENGE_KEY_PREFIX}${address}`;
}

const authService = {
  /** Store a short-lived challenge in the shared Redis instance. */
  async createChallenge(address, now = Date.now()) {
    assertValidAddress(address);

    const challenge = `Sign in to StellarCade\n\nNonce: ${randomBytes(16).toString('hex')}`;
    const record = { challenge, expiresAt: now + CHALLENGE_TTL_MS };
    await client.setEx(challengeKey(address), CHALLENGE_TTL_SECONDS, JSON.stringify(record));
    return challenge;
  },

  /**
   * Atomically consume the pending challenge for `address`, then verify the
   * signature. Consuming before verification means a bad signature cannot be
   * replayed, and two concurrent requests can never both verify the same
   * challenge, even on different backend instances.
   *
   * Throws on any failure; callers let that propagate to error middleware.
   */
  async verifySignature(address, signatureBase64, now = Date.now()) {
    assertValidAddress(address);

    if (typeof signatureBase64 !== 'string' || signatureBase64.length === 0) {
      throw new InvalidSignatureError();
    }

    const raw = await client.getDel(challengeKey(address));
    if (!raw) {
      throw new ChallengeNotFoundError();
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new ChallengeNotFoundError();
    }

    if (!record || typeof record.challenge !== 'string') {
      throw new ChallengeNotFoundError();
    }
    if (now >= record.expiresAt) {
      throw new ChallengeExpiredError();
    }

    let valid = false;
    try {
      const keypair = Keypair.fromPublicKey(address);
      const signature = Buffer.from(signatureBase64, 'base64');
      valid = keypair.verify(stellarSignedMessageHash(record.challenge), signature);
    } catch {
      valid = false;
    }

    if (!valid) {
      throw new InvalidSignatureError();
    }
  },

  /**
   * @param {{ id: number, wallet_address: string }} user
   * @returns {string} a signed HS256 JWT
   */
  issueToken(user) {
    if (!process.env.JWT_SECRET) {
      throw new AuthNotConfiguredError();
    }

    return jwt.sign(
      { id: user.id, walletAddress: user.wallet_address, address: user.wallet_address },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN }
    );
  },
};

module.exports = {
  authService,
  ChallengeNotFoundError,
  ChallengeExpiredError,
  InvalidAddressError,
  InvalidSignatureError,
  AuthNotConfiguredError,
};
