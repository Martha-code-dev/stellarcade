const mockClient = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue(undefined),
  isOpen: false,
  isReady: false,
};

const mockCreateClient = jest.fn(() => mockClient);

jest.mock('redis', () => ({ createClient: mockCreateClient }));

function loadRedisModule() {
  let redis;
  jest.isolateModules(() => {
    redis = require('../../src/config/redis');
  });
  return redis;
}

describe('redis connection ownership and teardown (#1564)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isOpen = false;
    mockClient.isReady = false;
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.quit.mockResolvedValue(undefined);
  });

  test('does not open a socket or schedule reconnects on import during tests', async () => {
    const redis = loadRedisModule();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient.mock.calls[0][0]).toMatchObject({
      disableOfflineQueue: true,
      reconnectStrategy: false,
    });
    expect(mockClient.connect).not.toHaveBeenCalled();
    await expect(redis.connectPromise).resolves.toBeUndefined();
  });

  test('connectRedis is a no-op for a test-owned module', async () => {
    const redis = loadRedisModule();

    await expect(redis.connectRedis()).resolves.toBeUndefined();
    expect(mockClient.connect).not.toHaveBeenCalled();
  });

  test('disconnectRedis does nothing when the client was never opened', async () => {
    const redis = loadRedisModule();

    await expect(redis.disconnectRedis()).resolves.toBeUndefined();
    expect(mockClient.quit).not.toHaveBeenCalled();
  });

  test('disconnectRedis quits an owned open client exactly once', async () => {
    const redis = loadRedisModule();
    mockClient.isOpen = true;

    await redis.disconnectRedis();
    await redis.disconnectRedis();

    expect(mockClient.quit).toHaveBeenCalledTimes(1);
  });

  test('a failed quit is swallowed so teardown never rejects the runner', async () => {
    const redis = loadRedisModule();
    mockClient.isOpen = true;
    mockClient.quit.mockRejectedValueOnce(new Error('already gone'));

    await expect(redis.disconnectRedis()).resolves.toBeUndefined();
  });
});
