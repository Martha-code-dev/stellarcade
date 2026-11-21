// @vitest-environment node

/**
 * Unit tests for the catalog player-count helpers.
 *
 * The invariant under test: a game's player count is either a measured number
 * (a real `0` included) or genuinely unknown. Unknown must never collapse to
 * `0`, and a longer catalog must never imply more players.
 */

import { describe, it, expect } from "vitest";
import {
  readGamePlayers,
  summarizeGamePlayers,
  type GameTelemetry,
} from "./typed-api-sdk";
import type { Game } from "../types/api-client";

const game = (id: string, players?: unknown): Game => ({
  id,
  name: id,
  status: "active",
  ...(players === undefined ? {} : { players }),
});

describe("readGamePlayers", () => {
  it("treats a missing count as unavailable", () => {
    expect(readGamePlayers(game("g1"))).toEqual({ available: false });
  });

  it("treats an explicit null as unavailable", () => {
    expect(readGamePlayers(game("g1", null))).toEqual({ available: false });
  });

  it("keeps a measured zero as a real value", () => {
    expect(readGamePlayers(game("g1", 0))).toEqual({ available: true, value: 0 });
  });

  it("reads a measured non-zero count", () => {
    expect(readGamePlayers(game("g1", 42))).toEqual({ available: true, value: 42 });
  });

  it("rejects non-numeric values rather than coercing them", () => {
    expect(readGamePlayers(game("g1", "12"))).toEqual({ available: false });
    expect(readGamePlayers(game("g1", NaN))).toEqual({ available: false });
    expect(readGamePlayers(game("g1", Infinity))).toEqual({ available: false });
  });
});

describe("summarizeGamePlayers", () => {
  it("reports a populated catalog with no telemetry as unavailable", () => {
    const catalog = [game("a"), game("b"), game("c"), game("d")];
    const summary = summarizeGamePlayers(catalog);

    expect(summary.available).toBe(false);
    expect(summary.total).toBe(0);
    expect(summary.measuredGames).toBe(0);
    expect(summary.totalGames).toBe(4);
  });

  it("distinguishes a measured zero from unknown", () => {
    const summary = summarizeGamePlayers([game("a", 0), game("b", 0)]);

    expect(summary.available).toBe(true);
    expect(summary.total).toBe(0);
    expect(summary.measuredGames).toBe(2);
  });

  it("sums measured non-zero counts", () => {
    const summary = summarizeGamePlayers([game("a", 3), game("b", 7)]);

    expect(summary.available).toBe(true);
    expect(summary.total).toBe(10);
    expect(summary.measuredGames).toBe(2);
    expect(summary.totalGames).toBe(2);
  });

  it("sums only the measured entries when telemetry is partial", () => {
    const summary = summarizeGamePlayers([game("a", 5), game("b"), game("c", 4)]);

    expect(summary.available).toBe(true);
    expect(summary.total).toBe(9);
    expect(summary.measuredGames).toBe(2);
    expect(summary.totalGames).toBe(3);
  });

  it("does not change availability when the catalog length changes without activity", () => {
    const small = summarizeGamePlayers([game("a"), game("b")]);
    const large = summarizeGamePlayers([game("a"), game("b"), game("c"), game("d"), game("e")]);

    expect(small.available).toBe(false);
    expect(large.available).toBe(false);
    expect(small.total).toBe(0);
    expect(large.total).toBe(0);
  });

  it("returns an unavailable summary for an empty catalog", () => {
    expect(summarizeGamePlayers([])).toEqual<ReturnType<typeof summarizeGamePlayers>>({
      available: false,
      total: 0,
      measuredGames: 0,
      totalGames: 0,
    });
  });
});

// Guards the exported union shape so the helpers cannot quietly start
// returning a bare number that callers would render as a real reading.
describe("GameTelemetry shape", () => {
  it("carries an explicit availability flag", () => {
    const unknown: GameTelemetry = { available: false };
    const measured: GameTelemetry = { available: true, value: 0 };

    expect(unknown.available).toBe(false);
    expect(measured).toEqual({ available: true, value: 0 });
  });
});
