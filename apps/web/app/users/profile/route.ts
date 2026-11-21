import { NextResponse } from 'next/server';

import {
  corsHeaders,
  forwardToBackend,
  forwardedHeadersFrom,
  proxyResponse,
  serviceError,
} from '../_lib/backend-proxy';

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/** Reads the one canonical profile record from the backend. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    // The old route also accepted the wallet in a header; keep that contract
    // by turning it into the backend's query parameter.
    const address = url.searchParams.get('address') || request.headers.get('x-wallet-address');
    const query = address ? `?address=${encodeURIComponent(address)}` : '';

    const upstream = await forwardToBackend('GET', `/users/profile${query}`, {
      headers: forwardedHeadersFrom(request),
    });
    return await proxyResponse(upstream);
  } catch (error) {
    return serviceError(error);
  }
}
