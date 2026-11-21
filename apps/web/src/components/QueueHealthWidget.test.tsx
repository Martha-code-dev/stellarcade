import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { QueueHealthWidget, type QueueMetrics } from "./QueueHealthWidget";

const METRICS: QueueMetrics = {
  playersInQueue: 14,
  averageWaitTime: 12,
  estimatedWaitTime: 8,
  activeMatches: 6,
  queueHealth: "healthy",
  lastUpdated: new Date().toISOString(),
};

describe("QueueHealthWidget", () => {
  it("renders queue name and metrics", () => {
    render(<QueueHealthWidget metrics={METRICS} queueName="Coin Flip Matchmaking" />);
    expect(screen.getByText("Coin Flip Matchmaking")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("8s")).toBeInTheDocument();
  });

  it("renders unavailable, not zero, when there is no telemetry", () => {
    render(
      <QueueHealthWidget
        queueName="Queue participation summary"
        metrics={{
          playersInQueue: null,
          averageWaitTime: null,
          estimatedWaitTime: null,
          activeMatches: null,
          queueHealth: "unknown",
          lastUpdated: null,
        }}
        showDetails
      />,
    );

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    // Every metric reads as an em dash rather than a fabricated 0.
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders unavailable when no metrics are supplied at all", () => {
    render(<QueueHealthWidget queueName="Queue participation summary" showDetails />);

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});