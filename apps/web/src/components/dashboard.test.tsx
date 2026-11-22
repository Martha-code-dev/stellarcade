import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";

/**
 * Dashboard player-count tests.
 *
 * The invariant: the "Players in queue" tile reflects measured telemetry only.
 * A catalog with no counts reads as unavailable (em dash), a measured zero
 * reads as a real 0, and a longer catalog never implies more players.
 */

const apiState = vi.hoisted(() => ({
  games: { success: false } as { success: boolean; data?: unknown[] },
}));

vi.mock("@/hooks/useWalletStatus", () => ({
  useWalletStatus: () => ({
    status: "DISCONNECTED",
    address: null,
    network: null,
    provider: null,
    capabilities: {
      isConnected: false,
      isConnecting: false,
      isReconnecting: false,
      canConnect: true,
    },
    error: null,
    lastUpdatedAt: null,
    isRefreshing: false,
    refreshState: {
      phase: "IDLE",
      trigger: "silent",
      attempt: 0,
      maxAttempts: 1,
      terminal: false,
    },
    sessionDropped: false,
    lastReconnectAt: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useXlmBalance", () => ({
  useXlmBalance: () => ({ amount: null, formatted: null, isLoading: false, isUnfunded: false }),
  default: () => ({ amount: null, formatted: null, isLoading: false, isUnfunded: false }),
}));

vi.mock("@/services/player-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/player-data")>()),
  useSettledRounds: () => ({ items: [], isLoading: false, error: null }),
}));

vi.mock("@/services/typed-api-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/typed-api-sdk")>();
  return {
    ...actual,
    ApiClient: class {
      getGames() {
        return Promise.resolve(apiState.games);
      }
    },
  };
});

const game = (id: string, players?: number) => ({
  id,
  name: id,
  status: "active",
  wager: 5,
  ...(players === undefined ? {} : { players }),
});

beforeEach(() => {
  apiState.games = { success: false };
});

describe("Dashboard player counts", () => {
  it("reads unavailable, not zero, for a populated catalog without telemetry", async () => {
    apiState.games = {
      success: true,
      data: [game("a"), game("b"), game("c"), game("d"), game("e")],
    };

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText("e")).toBeInTheDocument());

    const tile = screen.getByTestId("dashboard-players-tile");
    expect(within(tile).getByText("—")).toBeInTheDocument();
    expect(tile).toHaveTextContent("Player counts unavailable");
    expect(within(tile).queryByText("0")).not.toBeInTheDocument();
  });

  it("keeps a measured zero distinct from unavailable", async () => {
    apiState.games = { success: true, data: [game("a", 0)] };

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());

    const tile = screen.getByTestId("dashboard-players-tile");
    expect(within(tile).getByText("0")).toBeInTheDocument();
    expect(tile).toHaveTextContent("Across all games");
    expect(within(tile).queryByText("—")).not.toBeInTheDocument();
  });

  it("sums measured counts and notes partial coverage", async () => {
    apiState.games = { success: true, data: [game("a", 3), game("b", 7), game("c")] };

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText("c")).toBeInTheDocument());

    const tile = screen.getByTestId("dashboard-players-tile");
    expect(within(tile).getByText("10")).toBeInTheDocument();
    expect(tile).toHaveTextContent("Across 2 of 3 games");
  });

  it("does not infer players from the bundled catalog when the fetch fails", async () => {
    apiState.games = { success: false };

    render(<Dashboard />);

    const tile = await screen.findByTestId("dashboard-players-tile");
    expect(within(tile).getByText("—")).toBeInTheDocument();
    expect(tile).toHaveTextContent("Player counts unavailable");
    expect(within(tile).queryByText("0")).not.toBeInTheDocument();
  });
});
