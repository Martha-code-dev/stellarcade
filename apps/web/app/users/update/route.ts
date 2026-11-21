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

/** Username and Telegram-link updates go through the canonical backend. */
export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    const upstream = await forwardToBackend('POST', '/users/update', {
      body: rawText,
      headers: forwardedHeadersFrom(request),
    });
    return await proxyResponse(upstream);
  } catch (error) {
    return serviceError(error);
  }
}
