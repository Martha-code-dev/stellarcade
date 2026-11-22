/**
 * Shared profile input rules.
 *
 * The web app used to own the username/address rules for its own routes while
 * the Express endpoints accepted whatever they were sent. Both surfaces now
 * use this module so a bad value gets the same stable 400 no matter which
 * route it arrives on.
 *
 * Validators return `null` when the value is fine, or a plain problem object
 * the controller turns into its usual `{ statusCode, code, message }` error.
 */
const { StrKey } = require('@stellar/stellar-sdk');

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

const problem = (message, code, statusCode = 400) => ({ message, code, statusCode });

/** Wallet identities must be real Stellar public keys, never sentinel rows. */
function validateWalletAddress(value) {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    (typeof value === 'string' && !value.trim())
  ) {
    return problem('walletAddress is required.', 'INVALID_REQUEST');
  }
  if (typeof value !== 'string') {
    return problem('A valid Stellar public key (G...) is required.', 'INVALID_ADDRESS');
  }

  let valid = false;
  try {
    valid = StrKey.isValidEd25519PublicKey(value.trim());
  } catch {
    valid = false;
  }

  if (!valid) {
    return problem('A valid Stellar public key (G...) is required.', 'INVALID_ADDRESS');
  }
  return null;
}

/**
 * `required` is for callers that must have a name (first-run onboarding).
 * The backend's idempotent find-or-create path deliberately leaves it off so
 * the Telegram-link sync, which has no name to send yet, keeps working.
 */
function validateUsernameValue(value, { required = false } = {}) {
  // Omitted is allowed for the backend's idempotent find-or-create path.
  // An explicitly supplied empty value is never allowed on either route.
  if (value === undefined || value === null) {
    return required
      ? problem('Choose a username to finish setting up your account.', 'INVALID_USERNAME')
      : null;
  }
  if (typeof value !== 'string') {
    return problem('Username must be a string.', 'INVALID_USERNAME');
  }

  const name = value.trim();
  if (!name) {
    return problem('Choose a username to finish setting up your account.', 'INVALID_USERNAME');
  }
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
    return problem(
      `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters.`,
      'INVALID_USERNAME'
    );
  }
  if (!USERNAME_PATTERN.test(name)) {
    return problem('Username can only use letters, numbers, and . _ -', 'INVALID_USERNAME');
  }
  return null;
}

function validateOptionalString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return problem(`${field} must be a string.`, 'INVALID_FIELD');
  }
  return null;
}

function validateOptionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    return problem(`${field} must be a boolean.`, 'INVALID_FIELD');
  }
  return null;
}

/**
 * Validates a create or update body. Both routes call this with the same
 * options so their rules cannot drift apart again.
 */
function validateProfileInput(body, { requireUsername = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return problem('Request body must be an object.', 'INVALID_REQUEST');
  }

  const walletAddress = body.walletAddress || body.address;
  const addressProblem = validateWalletAddress(walletAddress);
  if (addressProblem) return addressProblem;

  const usernameProblem = validateUsernameValue(body.username, { required: requireUsername });
  if (usernameProblem) return usernameProblem;

  const ageProblem = validateOptionalBoolean(body.ageConfirmed, 'ageConfirmed');
  if (ageProblem) return ageProblem;

  const handleProblem = validateOptionalString(body.telegramHandle, 'telegramHandle');
  if (handleProblem) return handleProblem;

  const idProblem = validateOptionalString(body.telegramUserId, 'telegramUserId');
  if (idProblem) return idProblem;

  return null;
}

module.exports = {
  USERNAME_MIN,
  USERNAME_MAX,
  USERNAME_PATTERN,
  validateWalletAddress,
  validateUsernameValue,
  validateProfileInput,
};
