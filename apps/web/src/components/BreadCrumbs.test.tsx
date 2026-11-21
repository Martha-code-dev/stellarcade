import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/provider";

const mockUsePathname = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

const { default: Breadcrumbs } = await import("./BreadCrumbs.js");

function renderBreadcrumbs() {
  return render(
    <I18nProvider>
      <Breadcrumbs />
    </I18nProvider>,
  );
}

describe("Breadcrumbs", () => {
  // Breadcrumbs no longer renders a fixed root "Home" crumb — AppShell's own
  // header already has a "Home" link (see AppShell.tsx), so a second one
  // here would have been a redundant duplicate rather than a real gap.
  it("renders nothing at the root path", () => {
    mockUsePathname.mockReturnValue("/");
    const { container } = renderBreadcrumbs();
    expect(container.querySelector("nav")?.textContent).toBe("");
  });

  it("renders one crumb per path segment, using each route's known label", () => {
    mockUsePathname.mockReturnValue("/games/coin-flip");
    renderBreadcrumbs();
    // "games" is a known route (see ROUTE_KEYS) and renders its label, not
    // the raw segment text.
    expect(screen.getByRole("link", { name: "Games Arena" })).toHaveAttribute("href", "/games");
    expect(screen.getByText("coin flip")).toHaveAttribute("aria-current", "page");
  });

  it("replaces hyphens with spaces in segment labels not found in ROUTE_KEYS", () => {
    mockUsePathname.mockReturnValue("/profile/wallet-settings");
    renderBreadcrumbs();
    // "profile" is a known route -> "Player Profile"; "wallet-settings" is
    // not, so it falls back to hyphen-replaced raw text.
    expect(screen.getByRole("link", { name: "Player Profile" })).toBeInTheDocument();
    expect(screen.getByText("wallet settings")).toBeInTheDocument();
  });

  it("marks only the last segment as the current page", () => {
    mockUsePathname.mockReturnValue("/a/b/c");
    renderBreadcrumbs();
    const a = screen.getByRole("link", { name: "a" });
    const b = screen.getByRole("link", { name: "b" });
    // shadcn's BreadcrumbPage (used for the last segment) is role="link" too
    // — a deliberate a11y pattern for visual/semantic consistency with the
    // clickable crumbs — but it's aria-disabled and has an <a> href,
    // whereas a and b are real navigable links.
    expect(a).toHaveAttribute("href", "/a");
    expect(b).toHaveAttribute("href", "/a/b");
    const current = screen.getByText("c");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("aria-disabled", "true");
  });

  it("renders exactly one anchor per navigable crumb and never nests anchors", () => {
    mockUsePathname.mockReturnValue("/games/coin-flip/history");
    const { container } = renderBreadcrumbs();

    // "games" and "coin-flip" are navigable; "history" is the current page and
    // renders a span, not an anchor.
    const anchors = container.querySelectorAll("nav a");
    expect(anchors).toHaveLength(2);
    // A nested <a><a> would be invalid HTML and the source of the hydration
    // errors this issue fixes.
    expect(container.querySelector("a a")).toBeNull();

    expect(screen.getByRole("link", { name: "Games Arena" })).toHaveAttribute("href", "/games");
    expect(screen.getByRole("link", { name: "coin flip" })).toHaveAttribute(
      "href",
      "/games/coin-flip",
    );
  });

  it("keeps each navigable crumb reachable by keyboard in document order", async () => {
    mockUsePathname.mockReturnValue("/games/coin-flip");
    renderBreadcrumbs();

    const user = userEvent.setup();
    const games = screen.getByRole("link", { name: "Games Arena" });

    await user.tab();
    expect(games).toHaveFocus();
  });

  it("emits no nested-anchor or hydration diagnostics while rendering", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockUsePathname.mockReturnValue("/games/coin-flip/history");
      renderBreadcrumbs();

      const nesting = errorSpy.mock.calls.filter((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" &&
            (/cannot be a descendant/i.test(arg) || /hydration/i.test(arg)),
        ),
      );
      expect(nesting).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
