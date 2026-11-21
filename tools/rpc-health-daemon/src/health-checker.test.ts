import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { HealthChecker } from './health-checker.js';
import { Alerter } from './alerter.js';

interface CapturedRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const TEST_PORT = 19901;

let mockServer: http.Server;
let requests: CapturedRequest[] = [];
let healthResult: Record<string, unknown> = { status: 'OK' };
let ledgerResult: Record<string, unknown> = { sequence: 1000 };
let rpcError: { code: number; message: string } | null = null;
let forceId: number | null = null;
let forceVersion: string | null = null;
let httpStatus = 200;
let rawBody: string | null = null;
let delayMs = 0;

function envelope(id: number, result?: unknown, error?: unknown): Record<string, unknown> {
  const response: Record<string, unknown> = { jsonrpc: forceVersion ?? '2.0', id: forceId ?? id };
  if (error !== undefined) {
    response.error = error;
  } else {
    response.result = result ?? {};
  }
  return response;
}

function startMockServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        let parsed: CapturedRequest = {};
        try {
          parsed = JSON.parse(body) as CapturedRequest;
        } catch {
          /* captured as an empty request; malformed-request cases assert elsewhere */
        }
        requests.push(parsed);

        const send = () => {
          res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
          if (rawBody !== null) {
            res.end(rawBody);
            return;
          }
          if (rpcError) {
            res.end(JSON.stringify(envelope(Number(parsed.id), undefined, rpcError)));
            return;
          }
          const result = parsed.method === 'getHealth' ? healthResult : ledgerResult;
          res.end(JSON.stringify(envelope(Number(parsed.id), result)));
        };

        if (delayMs > 0) {
          setTimeout(send, delayMs);
        } else {
          send();
        }
      });
    });
    mockServer.listen(port, resolve);
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!mockServer) {
      resolve();
      return;
    }
    mockServer.close(() => resolve());
  });
}

function stubRpcPost(checker: HealthChecker, fn: (method: string) => Promise<Record<string, unknown>>): void {
  (checker as unknown as { rpcPost: typeof fn }).rpcPost = fn;
}

describe('HealthChecker', () => {
  let alerter: Alerter;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    alerter = new Alerter();
    requests = [];
    healthResult = { status: 'OK' };
    ledgerResult = { sequence: 1000 };
    rpcError = null;
    forceId = null;
    forceVersion = null;
    httpStatus = 200;
    rawBody = null;
    delayMs = 0;
    await startMockServer(TEST_PORT);
  });

  afterEach(async () => {
    await stopMockServer();
    vi.restoreAllMocks();
  });

  const url = () => `http://localhost:${TEST_PORT}`;

  it('should report healthy when RPC responds normally', async () => {
    const checker = new HealthChecker(url(), 60, alerter);

    const report = await checker.runCheck();

    expect(report.healthy).toBe(true);
    expect(report.degraded).toBe(false);
    expect(report.ledgerSequence).toBe(1000);
    expect(report.error).toBeNull();
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should report unhealthy when RPC health endpoint returns a bad status', async () => {
    healthResult = { status: 'NOT_OK' };

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toContain('NOT_OK');
  });

  it('should report unhealthy when server is unresponsive', async () => {
    await stopMockServer();

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toBeTruthy();
  });

  it('should track health history', async () => {
    const checker = new HealthChecker(url(), 60, alerter);

    await checker.runCheck();
    await checker.runCheck();
    await checker.runCheck();

    const history = checker.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].ledgerSequence).toBe(1000);
  });

  // #1567: protocol-faithful requests and responses

  it('sends JSON-RPC 2.0 envelopes with a version, method, params and incrementing ids', async () => {
    const checker = new HealthChecker(url(), 60, alerter);

    await checker.runCheck();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ jsonrpc: '2.0', method: 'getHealth', params: {} });
    expect(requests[1]).toMatchObject({ jsonrpc: '2.0', method: 'getLatestLedger', params: {} });
    expect(typeof requests[0].id).toBe('number');
    expect(typeof requests[1].id).toBe('number');
    expect(requests[1].id).toBe(Number(requests[0].id) + 1);
  });

  it('extracts the actual ledger sequence from the JSON-RPC result envelope', async () => {
    ledgerResult = { id: 'abc', protocolVersion: 21, sequence: 424242 };

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.ledgerSequence).toBe(424242);
    expect(report.healthy).toBe(true);
  });

  it('accepts a numeric string ledger sequence', async () => {
    ledgerResult = { sequence: '777' };

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.ledgerSequence).toBe(777);
  });

  it('surfaces a JSON-RPC error envelope as an unhealthy report', async () => {
    rpcError = { code: -32601, message: 'Method not found' };

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toContain('Method not found');
  });

  it('rejects a response whose id does not match the request', async () => {
    forceId = 999999;

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toContain('expected id');
  });

  it('rejects a response with an invalid jsonrpc version', async () => {
    forceVersion = '1.0';

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toContain('jsonrpc version');
  });

  it('rejects a non-JSON response body', async () => {
    rawBody = 'not json';

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toContain('Invalid JSON');
  });

  it('treats a non-2xx HTTP status as a failure', async () => {
    httpStatus = 503;

    const checker = new HealthChecker(url(), 60, alerter);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toContain('RPC HTTP error: 503');
  });

  it('times out a stalled HTTP response', async () => {
    delayMs = 300;

    const checker = new HealthChecker(url(), 60, alerter, 50);
    const report = await checker.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.error).toContain('timed out');
  });

  // #1568: non-overlapping loop, bounded stop, explicit stall semantics

  it('does not overlap a slow check across several intervals', async () => {
    let calls = 0;
    const checker = new HealthChecker(url(), 0.02, alerter);
    stubRpcPost(checker, async (method) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return method === 'getHealth' ? { status: 'OK' } : { sequence: 1000 };
    });

    checker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await checker.stop();

    // One check makes exactly two calls. Without an in-flight guard, the
    // interval ticks would have started many overlapping checks.
    expect(calls).toBe(2);
  });

  it('is safe to start and stop repeatedly without leaking timers', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const checker = new HealthChecker(url(), 60, alerter);
    stubRpcPost(checker, async (method) =>
      method === 'getHealth' ? { status: 'OK' } : { sequence: 1000 },
    );

    checker.start();
    checker.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await checker.stop();
    await checker.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    checker.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    await checker.stop();
  });

  it('classifies an unchanged ledger beyond the stall threshold as degraded and unhealthy', async () => {
    const checker = new HealthChecker(url(), 60, alerter);
    stubRpcPost(checker, async (method) =>
      method === 'getHealth' ? { status: 'OK' } : { sequence: 1000 },
    );

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = await checker.runCheck();
    expect(first.stalled).toBe(false);
    expect(first.healthy).toBe(true);

    nowSpy.mockReturnValue(1_000_000 + 31_000);
    const second = await checker.runCheck();

    expect(second.stalled).toBe(true);
    expect(second.degraded).toBe(true);
    expect(second.healthy).toBe(false);
    expect(second.error).toContain('stalled');
  });

  it('does not flag a stall before the threshold elapses', async () => {
    const checker = new HealthChecker(url(), 60, alerter);
    stubRpcPost(checker, async (method) =>
      method === 'getHealth' ? { status: 'OK' } : { sequence: 1000 },
    );

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await checker.runCheck();
    nowSpy.mockReturnValue(1_000_000 + 10_000);
    const second = await checker.runCheck();

    expect(second.stalled).toBe(false);
    expect(second.healthy).toBe(true);
  });

  it('should start and stop the check loop', async () => {
    const checker = new HealthChecker(url(), 1, alerter);

    checker.start();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await checker.stop();

    const historyAfterStop = checker.getHistory().length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const historyStillSame = checker.getHistory().length;

    expect(historyAfterStop).toBeGreaterThan(0);
    expect(historyStillSame).toBe(historyAfterStop);
  });
});
