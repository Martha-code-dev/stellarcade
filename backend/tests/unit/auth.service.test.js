/**
 * Unit tests for auth.service — challenge issuance, SEP-53 signature
 * verification, and JWT issuance.
 */
const { createHash } = require('crypto');
const jwt = require('jsonwebtoken');
const { Keypair } = require('@stellar/stellar-sdk');

const mockStore = new Map();

jest.mock('../../src/config/redis', () => ({
  client: {
    setEx: jest.fn(async (key, _ttl, value) => {
      mockStore.set(key, value);
      return 'OK';
    }),
    getDel: jest.fn(async (key) => {
      const value = mockStore.get(key) ?? null;
      mockStore.delete(key);
      return value;
    }),
  },
  connectPromise: Promise.resolve(),
}));

const {
  authService,
  ChallengeNotFoundError,
  ChallengeExpiredError,
  InvalidAddressError,
  InvalidSignatureError,
  AuthNotConfiguredError,
} = require('../../src/services/auth.service');

/** Mirrors how Freighter (and SEP-53-style wallets) actually sign messages. */
function signChallenge(keypair, challenge) {
  const hash = createHash('sha256')
    .update(`Stellar Signed Message:\n${challenge}`, 'utf8')
    .digest();
  return keypair.sign(hash).toString('base64');
}

describe('authService.createChallenge / verifySignature', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  test('verifies a correctly signed challenge and consumes it', async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const challenge = await authService.createChallenge(address);
    const signature = signChallenge(keypair, challenge);

    await expect(authService.verifySignature(address, signature)).resolves.toBeUndefined();
    await expect(authService.verifySignature(address, signature)).rejects.toThrow(
      ChallengeNotFoundError
    );
  });

  test('rejects a malformed address before touching the challenge store', async () => {
    await expect(authService.createChallenge('not-a-real-address')).rejects.toThrow(
      InvalidAddressError
    );
    await expect(authService.verifySignature('not-a-real-address', 'sig')).rejects.toThrow(
      InvalidAddressError
    );
    expect(mockStore.size).toBe(0);
  });

  test('rejects a signature from the wrong keypair', async () => {
    const signer = Keypair.random();
    const claimedAddress = Keypair.random().publicKey();

    const challenge = await authService.createChallenge(claimedAddress);
    const signature = signChallenge(signer, challenge);

    await expect(authService.verifySignature(claimedAddress, signature)).rejects.toThrow(
      InvalidSignatureError
    );
  });

  test('consumes a challenge even when the signature is invalid', async () => {
    const address = Keypair.random().publicKey();
    await authService.createChallenge(address);

    await expect(authService.verifySignature(address, 'bm90LWEtc2ln')).rejects.toThrow(
      InvalidSignatureError
    );
    await expect(authService.verifySignature(address, 'bm90LWEtc2ln')).rejects.toThrow(
      ChallengeNotFoundError
    );
  });

  test('stores the challenge with a bounded Redis TTL', async () => {
    const address = Keypair.random().publicKey();
    const { client } = require('../../src/config/redis');

    await authService.createChallenge(address);

    expect(client.setEx).toHaveBeenCalledWith(
      `auth:login-challenge:${address}`,
      300,
      expect.any(String)
    );
  });

  test('throws ChallengeNotFoundError when no challenge is pending', async () => {
    const address = Keypair.random().publicKey();
    await expect(authService.verifySignature(address, 'sig')).rejects.toThrow(
      ChallengeNotFoundError
    );
  });

  test('throws ChallengeExpiredError after the TTL elapses', async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    const now = 1_000_000;

    const challenge = await authService.createChallenge(address, now);
    const signature = signChallenge(keypair, challenge);

    await expect(
      authService.verifySignature(address, signature, now + 6 * 60 * 1000)
    ).rejects.toThrow(ChallengeExpiredError);
  });

  test('a challenge removed by Redis expiry is no longer verifiable', async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    const challenge = await authService.createChallenge(address);
    const signature = signChallenge(keypair, challenge);

    mockStore.clear();

    await expect(authService.verifySignature(address, signature)).rejects.toThrow(
      ChallengeNotFoundError
    );
  });
});

describe('authService.issueToken', () => {
  const OLD_ENV = process.env.JWT_SECRET;
  afterEach(() => {
    process.env.JWT_SECRET = OLD_ENV;
  });

  test('throws AuthNotConfiguredError when JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    expect(() => authService.issueToken({ id: 1, wallet_address: 'GALICE' })).toThrow(
      AuthNotConfiguredError
    );
  });

  test('issues a verifiable HS256 token carrying id and walletAddress', () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = authService.issueToken({ id: 7, wallet_address: 'GALICE' });

    const decoded = jwt.verify(token, 'test-secret', { algorithms: ['HS256'] });
    expect(decoded).toEqual(
      expect.objectContaining({ id: 7, walletAddress: 'GALICE', address: 'GALICE' })
    );
  });
});
