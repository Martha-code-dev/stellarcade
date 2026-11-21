import { NextResponse } from 'next/server';

/**
 * The `/users/*` Next routes used to own a JSON file separate from the
 * backend's PostgreSQL table. They are now thin adapters over the canonical
 * Express API so both surfaces persist the same identity.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wallet-Address',
};

type ProxyErrorCode = 'NOT_CONFIGURED' | 'UNAVAILABLE';

export class BackendProxyError extends Error {
  readonly code: ProxyErrorCode;

  constructor(message: string, code: ProxyErrorCode) {
    super(message);
    this.name = 'BackendProxyError';
    this.code = code;
  }
}

/** Only pass through headers that are meaningful to the backend. */
export function forwardedHeadersFrom(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = request.headers.get('authorization');
  if (authorization) headers.Authorization = authorization;
  const walletAddress = request.headers.get('x-wallet-address');
  if (walletAddress) headers['X-Wallet-Address'] = walletAddress;
  return headers;
}

export async function forwardToBackend(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  // A server-side override is supported; the public variable is the fallback
  // because that is what the rest of the web app already configures.
  const baseUrl = (
    process.env.API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    ''
  ).replace(/\/+$/, '');

  if (!baseUrl) {
    throw new BackendProxyError('Profile service is not configured.', 'NOT_CONFIGURED');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');

  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      cache: 'no-store',
    });
  } catch {
    throw new BackendProxyError('Profile service is unavailable.', 'UNAVAILABLE');
  }
}

/**
 * Preserve the web routes' existing `{ error: string }` shape while passing
 * through the backend's status code and machine-readable error code.
 */
export async function proxyResponse(upstream: Response): Promise<NextResponse> {
  const text = await upstream.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (upstream.ok) {
    return NextResponse.json(payload ?? {}, {
      status: upstream.status,
      headers: corsHeaders,
    });
  }

  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const errorValue = envelope.error;
  const errorObject =
    errorValue && typeof errorValue === 'object' && !Array.isArray(errorValue)
      ? (errorValue as Record<string, unknown>)
      : {};

  const message =
    typeof errorValue === 'string'
      ? errorValue
      : typeof errorObject.message === 'string'
        ? errorObject.message
        : 'Profile request failed.';

  const code =
    typeof errorObject.code === 'string'
      ? errorObject.code
      : typeof envelope.code === 'string'
        ? envelope.code
        : undefined;

  return NextResponse.json(
    { error: message, ...(code ? { code } : {}) },
    { status: upstream.status, headers: corsHeaders },
  );
}

export function serviceError(error: unknown): NextResponse {
  if (error instanceof BackendProxyError) {
    const status = error.code === 'NOT_CONFIGURED' ? 500 : 502;
    return NextResponse.json({ error: error.message }, { status, headers: corsHeaders });
  }
  const message = error instanceof Error ? error.message : 'Profile request failed.';
  return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
}
