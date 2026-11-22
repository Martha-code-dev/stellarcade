/**
 * Knex migration for distributed worker leases.
 *
 * A lease lets several identical worker processes share one job without
 * executing it twice. Only the process whose `owner` matches and whose
 * `expires_at` is still in the future runs the job; every other process skips
 * until the lease expires. The RNG oracle uses this so two backend replicas
 * cannot bind or reveal the same seed concurrently (#1578).
 *
 * `expires_at` is epoch milliseconds (a bigint), not a timestamp, so the
 * comparison is exact and dialect-independent.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('worker_leases', (table) => {
    table.string('name', 50).primary();
    table.string('owner', 128).notNullable();
    table.bigInteger('expires_at').notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('worker_leases');
};
