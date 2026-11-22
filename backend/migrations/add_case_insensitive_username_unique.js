/**
 * Canonical usernames are unique regardless of display casing (#1587).
 *
 * The legacy backend auto-provisioned `player` for every wallet and the
 * find-then-insert paths could create case-only duplicates. Keep the oldest
 * row for each canonical name so its display spelling is preserved, clear the
 * duplicates back to the nullable state, then let PostgreSQL and SQLite both
 * enforce the invariant with a functional unique index. NULL is allowed
 * because first login reserves only the wallet, not a public name.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.raw(`
    UPDATE users
    SET username = NULL
    WHERE username IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id)
        FROM users
        WHERE username IS NOT NULL
        GROUP BY LOWER(username)
      )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique
    ON users (LOWER(username))
    WHERE username IS NOT NULL
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS users_username_lower_unique');
};
