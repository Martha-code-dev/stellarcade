import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import LandingPage from "./page";

/**
 * jsdom has no 2D canvas implementation. NeonMesh only needs a small drawing
 * surface to run its render loop, so provide a no-op boundary double here
 * instead of installing the native `canvas` package or muting the resulting
 * "Not implemented: getContext" diagnostic globally.
 */
function createCanvasContextDouble(): CanvasRenderingContext2D {
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: () => {},
    fill: () => {},
    scale: () => {},
  } as unknown as CanvasRenderingContext2D;
}

describe("LandingPage", () => {
  let getContextSpy: MockInstance<typeof HTMLCanvasElement.prototype.getContext>;
  let errorSpy: MockInstance<typeof console.error>;
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => createCanvasContextDouble());
    errorSpy = vi.spyOn(console, "error");
    warnSpy = vi.spyOn(console, "warn");
  });

  afterEach(() => {
    cleanup();
    const unexpectedErrors = errorSpy.mock.calls;
    const unexpectedWarnings = warnSpy.mock.calls;
    getContextSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    // Fail on any remaining diagnostic instead of suppressing it globally.
    expect(unexpectedErrors).toEqual([]);
    expect(unexpectedWarnings).toEqual([]);
  });

  it("renders the hero heading", () => {
    render(<LandingPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "The provably-fair arcade, on-chain",
    );
  });

  it("links to the arcade app and the games list", () => {
    render(<LandingPage />);
    // "Enter the arcade" and "Browse games" each appear twice (hero + the
    // cinematic footer's own CTA pair). A dedicated /games route now
    // exists, so "Browse games" points there rather than falling back to
    // /app the way it did before that route was added.
    for (const link of screen.getAllByRole("link", { name: "Enter the arcade" })) {
      expect(link).toHaveAttribute("href", "/app");
    }
    for (const link of screen.getAllByRole("link", { name: "Browse games" })) {
      expect(link).toHaveAttribute("href", "/games");
    }
  });

  it("renders all four feature cards", () => {
    render(<LandingPage />);
    expect(screen.getByText("Provably fair")).toBeInTheDocument();
    expect(screen.getByText("No custody, ever")).toBeInTheDocument();
    expect(screen.getByText("Real prize pools")).toBeInTheDocument();
    expect(screen.getByText("Built for Stellar")).toBeInTheDocument();
  });

  it("has a skip link targeting #main", () => {
    render(<LandingPage />);
    expect(screen.getByText("Skip to main content")).toHaveAttribute("href", "#main");
  });

  it("footer links to terms and privacy", () => {
    render(<LandingPage />);
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  });
});
