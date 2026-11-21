import * as http from 'http';
import * as https from 'https';
import type { ProxyConfig, RequestLogEntry } from './types';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_LOG_ENTRIES = 100;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Picks a latency value uniformly between config.minLatencyMs and
 * config.maxLatencyMs (inclusive).
 */
export function pickLatencyMs(config: ProxyConfig): number {
  const { minLatencyMs, maxLatencyMs } = config;
  if (maxLatencyMs <= minLatencyMs) return minLatencyMs;
  return minLatencyMs + Math.random() * (maxLatencyMs - minLatencyMs);
}

/** Returns true if this request should be faulted, per config.faultRate. */
export function shouldFault(config: ProxyConfig): boolean {
  return Math.random() < config.faultRate;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError(signal?.reason));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        cleanup();
        reject(createAbortError(signal.reason));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'aborted');
}

function getMaxBodyBytes(config: ProxyConfig): number {
  return config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
}

function getMaxLogEntries(config: ProxyConfig): number {
  return config.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
}

function getUpstreamTimeoutMs(config: ProxyConfig): number {
  return config.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
}

export class LatencyProxy {
  private server: http.Server | null = null;
  public readonly log: RequestLogEntry[] = [];
  private readonly inflight = new Set<AbortController>();

  constructor(private readonly config: ProxyConfig) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.on('error', reject);
      this.server.listen(this.config.port, () => resolve());
    });
  }

  stop(): Promise<void> {
    // Cancel any pending work so shutdown does not hang.
    for (const controller of this.inflight) {
      controller.abort(new Error('proxy shutdown'));
    }
    this.inflight.clear();

    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private pushLog(entry: RequestLogEntry): void {
    this.log.push(entry);
    const max = getMaxLogEntries(this.config);
    if (max >= 0 && this.log.length > max) {
      this.log.splice(0, this.log.length - max);
    }
  }

  private async readBody(req: http.IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;

    return await new Promise<Buffer>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        req.destroy(createAbortError(signal.reason));
        reject(createAbortError(signal.reason));
      };
      const onData = (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
          cleanup();
          // Stop buffering further data but keep the socket writable so we can return 413.
          req.pause();
          req.removeAllListeners('data');
          req.on('data', () => undefined);
          req.resume();
          reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
          return;
        }
        chunks.push(buf);
      };
      const onEnd = () => {
        cleanup();
        resolve(Buffer.concat(chunks));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        // If closed before end without error, treat as abort/disconnect.
        if (!req.readableEnded) {
          cleanup();
          reject(new Error('client disconnected'));
        }
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('close', onClose);
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  }

  private async forwardUpstream(
    body: Buffer,
    signal: AbortSignal,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    const target = new URL(this.config.targetRpcUrl);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = getUpstreamTimeoutMs(this.config);
    const maxBytes = getMaxBodyBytes(this.config);

    return await new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.length;
            if (total > maxBytes) {
              cleanup();
              req.destroy(new Error('Upstream response body too large'));
              res.destroy();
              reject(Object.assign(new Error('Upstream response body too large'), { statusCode: 502 }));
              return;
            }
            chunks.push(buf);
          });
          res.on('end', () => {
            cleanup();
            resolve({ statusCode: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) });
          });
          res.on('error', (err) => {
            cleanup();
            reject(err);
          });
        },
      );

      let finished = false;
      const timeout = setTimeout(() => {
        if (finished) return;
        req.destroy(new Error('Upstream request timed out'));
      }, timeoutMs);

      const onAbort = () => {
        if (finished) return;
        req.destroy(createAbortError(signal.reason));
      };

      const cleanup = () => {
        finished = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      };

      req.on('error', (err) => {
        cleanup();
        reject(err);
      });
      req.on('close', () => {
        cleanup();
      });

      if (signal.aborted) {
        cleanup();
        req.destroy(createAbortError(signal.reason));
        reject(createAbortError(signal.reason));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      req.write(body);
      req.end();
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const controller = new AbortController();
    this.inflight.add(controller);
    const { signal } = controller;
    const started = Date.now();
    let method = 'unknown';
    let faulted = false;
    let statusCode = 500;
    let errorMessage: string | undefined;

    const onClientAbort = () => {
      if (!signal.aborted) controller.abort(new Error('client disconnected'));
    };
    req.on('aborted', onClientAbort);
    res.on('close', () => {
      // If the response closes before we finish writing, treat as client disconnect/cancel.
      if (!res.writableEnded) onClientAbort();
    });

    try {
      const body = await this.readBody(req, getMaxBodyBytes(this.config), signal);
      try {
        method = JSON.parse(body.toString('utf-8'))?.method ?? 'unknown';
      } catch {
        method = 'unknown';
      }

      const latencyMs = pickLatencyMs(this.config);
      await sleep(latencyMs, signal);

      faulted = shouldFault(this.config);
      if (faulted) {
        statusCode = this.config.faultStatusCode;
        if (!res.headersSent) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Simulated network fault' },
            }),
          );
        }
        this.pushLog({ method, latencyMs, faulted, timestamp: new Date().toISOString(), statusCode });
        return;
      }

      const upstream = await this.forwardUpstream(body, signal);
      statusCode = upstream.statusCode;
      if (!res.headersSent) {
        const contentType = (upstream.headers['content-type'] as string | undefined) ?? 'application/json';
        res.writeHead(upstream.statusCode, { 'Content-Type': contentType });
        res.end(upstream.body);
      }
      this.pushLog({ method, latencyMs, faulted, timestamp: new Date().toISOString(), statusCode });
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      errorMessage = e.message;
      const aborted = signal.aborted;
      const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? '');
      if (e.statusCode === 413 || e.message === 'Request body too large') {
        statusCode = 413;
      } else if (aborted && (reason === 'client disconnected' || req.aborted)) {
        statusCode = 499;
      } else if (aborted && reason === 'proxy shutdown') {
        statusCode = 503;
      } else {
        statusCode = e.statusCode ?? 502;
      }

      if (!res.headersSent && !res.writableEnded) {
        try {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: statusCode === 413 ? -32000 : -32001, message: e.message || 'Proxy error' },
            }),
          );
        } catch {
          // ignore write errors on aborted sockets
        }
      }
      this.pushLog({
        method,
        latencyMs: 0,
        faulted,
        timestamp: new Date().toISOString(),
        statusCode,
        error: errorMessage,
      });
    } finally {
      req.off('aborted', onClientAbort);
      this.inflight.delete(controller);
    }
  }
}
