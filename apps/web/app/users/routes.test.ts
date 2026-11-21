import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createProfile } from "./create/route";
import { POST as updateProfile } from "./update/route";
import { GET as getProfile } from "./profile/route";

/*
 * These routes are now adapters over the Express API. The tests pin down the
 * forwarding contract and the error mapping, and assert that no local JSON
 * file is written any more.
 */
const DB_FILE = path.join(process.cwd(), ".data", "user_profiles.json");
const WALLET = "GAEP3MEIODZFPOYG3H644CBXWFSPGCQC7DM74GSJIH6SH7RJZTAE3XYE";

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function backendResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function post(handler: typeof createProfile, body: unknown, headers: Record<string, string> = {}) {
  return handler(
    new Request("http://localhost/users/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.API_BASE_URL = "http://backend.test";
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.API_BASE_URL;
});

describe("POST /users/create", () => {
  it("forwards the body, authorization and wallet header to the backend", async () => {
    const profile = { address: WALLET, username: "nova_runner", ageConfirmedAt: "2026-01-01T00:00:00.000Z" };
    fetchMock.mockResolvedValue(backendResponse(201, profile));

    const res = await post(createProfile, { address: WALLET, username: "nova_runner", ageConfirmed: true }, {
      Authorization: "Bearer token-123",
      "X-Wallet-Address": WALLET,
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ username: "nova_runner" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.test/users/create");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      address: WALLET,
      username: "nova_runner",
      ageConfirmed: true,
    });
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("X-Wallet-Address")).toBe(WALLET);
  });

  it("maps a backend validation error to the web error shape with status 400", async () => {
    fetchMock.mockResolvedValue(
      backendResponse(400, {
        error: {
          message: "Username must be 3-20 characters.",
          code: "INVALID_USERNAME",
          status: 400,
        },
      }),
    );

    const res = await post(createProfile, { address: WALLET, username: "ab" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Username must be 3-20 characters.",
      code: "INVALID_USERNAME",
    });
  });

  it("does not write a local profile file", async () => {
    const before = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, "utf-8") : null;
    fetchMock.mockResolvedValue(backendResponse(201, { address: WALLET }));

    await post(createProfile, { address: WALLET, username: "nova_runner" });

    const after = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, "utf-8") : null;
    expect(after).toBe(before);
  });
});

describe("POST /users/update", () => {
  it("forwards an authenticated rename to the backend", async () => {
    fetchMock.mockResolvedValue(backendResponse(200, { address: WALLET, username: "new_name" }));

    const res = await post(updateProfile, { address: WALLET, username: "new_name" }, {
      Authorization: "Bearer token-123",
    });

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.test/users/update");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-123");
  });
});

describe("GET /users/profile", () => {
  it("forwards the address query parameter", async () => {
    fetchMock.mockResolvedValue(backendResponse(200, { address: WALLET, username: "nova_runner" }));

    const res = await getProfile(new Request(`http://localhost/users/profile?address=${WALLET}`));

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://backend.test/users/profile?address=${WALLET}`);
  });

  it("turns the legacy x-wallet-address header into a backend query parameter", async () => {
    fetchMock.mockResolvedValue(backendResponse(200, { address: WALLET }));

    await getProfile(
      new Request("http://localhost/users/profile", { headers: { "x-wallet-address": WALLET } }),
    );

    expect(fetchMock.mock.calls[0][0]).toBe(`http://backend.test/users/profile?address=${WALLET}`);
  });

  it("preserves the 404 and PROFILE_NOT_FOUND signal", async () => {
    fetchMock.mockResolvedValue(
      backendResponse(404, { error: { message: "No profile found.", code: "PROFILE_NOT_FOUND" } }),
    );

    const res = await getProfile(
      new Request(`http://localhost/users/profile?address=${WALLET}`),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "No profile found.", code: "PROFILE_NOT_FOUND" });
  });
});

describe("proxy failure handling", () => {
  it("reports a missing backend configuration explicitly", async () => {
    delete process.env.API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    const res = await post(createProfile, { address: WALLET, username: "nova_runner" });

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "Profile service is not configured." });
  });

  it("reports an unavailable backend as 502", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const res = await post(createProfile, { address: WALLET, username: "nova_runner" });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "Profile service is unavailable." });
  });
});
