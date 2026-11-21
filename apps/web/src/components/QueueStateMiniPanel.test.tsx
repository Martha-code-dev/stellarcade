import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";
import { QueueStateMiniPanel } from "./QueueStateMiniPanel";
import type { QueueMetrics } from "./QueueHealthWidget";

const METRICS: QueueMetrics = {
  playersInQueue: 8,
  averageWaitTime: 15,
  estimatedWaitTime: 10,
  activeMatches: 4,
  queueHealth: "healthy",
  lastUpdated: new Date().toISOString(),
};

describe("QueueStateMiniPanel", () => {
  it("renders queue mini panel with metrics and status", () => {
    render(<QueueStateMiniPanel metrics={METRICS} title="Coin Flip Lobby" />);
    expect(screen.getByText("Coin Flip Lobby")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("10s")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders unavailable, not zero, when there is no telemetry", () => {
    render(
      <QueueStateMiniPanel
        title="Coin Flip Lobby"
        metrics={{
          playersInQueue: null,
          averageWaitTime: null,
          estimatedWaitTime: null,
          activeMatches: null,
          queueHealth: "unknown",
          lastUpdated: null,
        }}
      />,
    );

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    const metrics = screen.getByTestId("queue-state-mini-panel-metrics");
    expect(within(metrics).getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders unavailable when no metrics are supplied at all", () => {
    render(<QueueStateMiniPanel title="Coin Flip Lobby" />);

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
