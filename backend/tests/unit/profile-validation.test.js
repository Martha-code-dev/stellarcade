const {
  USERNAME_MIN,
  USERNAME_MAX,
  validateWalletAddress,
  validateUsernameValue,
  validateProfileInput,
} = require('../../src/utils/profile-validation');

const VALID_ADDRESS = 'GAEP3MEIODZFPOYG3H644CBXWFSPGCQC7DM74GSJIH6SH7RJZTAE3XYE';

describe('validateWalletAddress', () => {
  test.each([undefined, null, '', '   '])('rejects a missing address (%p)', (value) => {
    expect(validateWalletAddress(value)).toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
    });
  });

  test.each(['G_GUEST_PLAYER', 'not-an-address', 123, {}, VALID_ADDRESS.slice(0, -1)])(
    'rejects the malformed address %p',
    (value) => {
      expect(validateWalletAddress(value)).toMatchObject({
        code: 'INVALID_ADDRESS',
        statusCode: 400,
      });
    }
  );

  test('accepts a real Stellar public key, including surrounding whitespace', () => {
    expect(validateWalletAddress(`  ${VALID_ADDRESS}  `)).toBeNull();
  });
});

describe('validateUsernameValue', () => {
  test.each([
    ['a number', 42],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['below the minimum', 'a'.repeat(USERNAME_MIN - 1)],
    ['above the maximum', 'a'.repeat(USERNAME_MAX + 1)],
    ['a space', 'has spaces'],
    ['an invalid symbol', 'bad@name'],
  ])('rejects %s', (_label, value) => {
    const result = validateUsernameValue(value);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ code: 'INVALID_USERNAME', statusCode: 400 });
  });

  test('accepts the documented character set at both boundaries', () => {
    expect(validateUsernameValue('a'.repeat(USERNAME_MIN))).toBeNull();
    expect(validateUsernameValue('a'.repeat(USERNAME_MAX))).toBeNull();
    expect(validateUsernameValue('a.b-c_1')).toBeNull();
  });

  test('trims before measuring', () => {
    expect(validateUsernameValue(`  ${'a'.repeat(USERNAME_MIN)}  `)).toBeNull();
  });

  test('required mode rejects an omitted name', () => {
    expect(validateUsernameValue(undefined, { required: true })).toMatchObject({
      code: 'INVALID_USERNAME',
    });
  });
});

describe('validateProfileInput', () => {
  test('accepts a well-formed create body', () => {
    expect(
      validateProfileInput({
        walletAddress: VALID_ADDRESS,
        username: 'nova_runner',
        ageConfirmed: true,
        telegramHandle: '@runner',
        telegramUserId: '12345',
      })
    ).toBeNull();
  });

  test('accepts the idempotent find-or-create body used by the Telegram link flow', () => {
    expect(validateProfileInput({ address: VALID_ADDRESS })).toBeNull();
  });

  test('rejects a non-object body', () => {
    expect(validateProfileInput([])).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(validateProfileInput(null)).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('applies the same username rules on create and update', () => {
    const body = { walletAddress: VALID_ADDRESS, username: 'bad@name' };
    expect(validateProfileInput(body)).toMatchObject({ code: 'INVALID_USERNAME' });
  });
});
