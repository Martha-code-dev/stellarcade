/**
 * Redis-backed login challenge tests: two backend instances share one store,
 * and a challenge can be consumed by only one of two concurrent verifiers.
 */
const { createHash } = require('crypto');
const { Keypair } = require('@stellar/stellar-sdk');

const mockStore = new Map();

function redisMock() {
  return {
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
  };
}

function loadAuthService() {
  jest.resetModules();
  jest.doMock('../../src/config/redis', redisMock);
  return require('../../src/services/auth.service');
}

function signChallenge(keypair, challenge) {
  const hash = createHash('sha256')
    .update(`Stellar Signed Message:\n${challenge}`, 'utf8')
    .digest();
  return keypair.sign(hash).toString('base64');
}

describe('shared login challenges', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  test('a challenge issued by one backend instance verifies on another', async () => {
    const instanceA = loadAuthService();
    const instanceB = loadAuthService();
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const challenge = await instanceA.authService.createChallenge(address);
    const signature = signChallenge(keypair, challenge);

    await expect(instanceB.authService.verifySignature(address, signature)).resolves.toBeUndefined();
  });

  test('concurrent replay consumes the challenge exactly once', async () => {
    const instanceA = loadAuthService();
    const instanceB = loadAuthService();
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const challenge = await instanceA.authService.createChallenge(address);
    const signature = signChallenge(keypair, challenge);

    const results = await Promise.allSettled([
      instanceA.authService.verifySignature(address, signature),
      instanceB.authService.verifySignature(address, signature),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(mockStore.has(`auth:login-challenge:${address}`)).toBe(false);
  });
});
