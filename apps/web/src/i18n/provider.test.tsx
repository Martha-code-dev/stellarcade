import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { I18nProvider, useI18n, resolveIntlLocale, isSupportedLocale } from "./provider";

/** jsdom in this environment has no Storage implementation. */
function installLocalStorageDouble(): void {
  const store = new Map<string, string>();
  const double = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    value: double,
    configurable: true,
    writable: true,
  });
}

function Probe() {
  const { locale, t, setLocale } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{t("app.title")}</span>
      <button onClick={() => setLocale("es")}>switch</button>
    </div>
  );
}

describe("I18nProvider", () => {
  let errorSpy: MockInstance<typeof console.error>;
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    installLocalStorageDouble();
    errorSpy = vi.spyOn(console, "error");
    warnSpy = vi.spyOn(console, "warn");
  });

  afterEach(() => {
    cleanup();
    const unexpectedErrors = errorSpy.mock.calls;
    const unexpectedWarnings = warnSpy.mock.calls;
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    expect(unexpectedErrors).toEqual([]);
    expect(unexpectedWarnings).toEqual([]);
  });

  it("defaults to English and resolves a known key", async () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    // The provider loads messages in an async effect. Flush it inside act so
    // the resulting state update is not reported as an unwrapped act warning.
    await act(async () => {});

    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("title")).toHaveTextContent("StellarCade");
  });

  it("switches locale and persists the choice", async () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByText("switch"));
    });
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("es"));

    expect(localStorage.getItem("stellarcade_locale")).toBe("es");
  });
});

describe("isSupportedLocale", () => {
  it("accepts the five supported locales", () => {
    for (const l of ["en", "es", "fr", "de", "ja"]) {
      expect(isSupportedLocale(l)).toBe(true);
    }
  });

  it("rejects unsupported values", () => {
    expect(isSupportedLocale("zz")).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});

describe("resolveIntlLocale", () => {
  it("maps a supported locale to its Intl tag", () => {
    expect(resolveIntlLocale("ja")).toBe("ja-JP");
  });

  it("falls back to en-US for null", () => {
    expect(resolveIntlLocale(null)).toBe("en-US");
  });
});
