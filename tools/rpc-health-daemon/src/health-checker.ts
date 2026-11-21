import https from 'node:https';
import http from 'node:http';
import { Alerter } from './alerter.js';

export interface HealthReport {
  timestamp: string;
  healthy: boolean;
  /** Soft-degraded (stalled ledger) as opposed to a hard RPC failure. */
  degraded?: boolean;
  ledgerSequence: number | null;
  latencyMs: number;
  latencySpike: boolean;
  stalled: boolean;
  error: string | null;
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

const STALL_THRESHOLD_MS = 30_000;
const LATENCY_SPIKE_MS = 1_000;
const MAX_HISTORY = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class HealthChecker {
  private rpcUrl: string;
  private intervalSec: number;
  private alerter: Alerter;
  private requestTimeoutMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The currently executing check, used to prevent overlapping polls. */
  private inFlight: Promise<void> | null = null;
  private requestId = 0;
  private lastLedgerSequence: number | null = null;
  private lastLedgerTimestamp: number | null = null;
  private history: HealthReport[] = [];

  constructor(
    rpcUrl: string,
    intervalSec: number,
    alerter: Alerter,
    requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.rpcUrl = rpcUrl;
    this.intervalSec = intervalSec;
    this.alerter = alerter;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.triggerCheck();
    this.intervalHandle = setInterval(() => this.triggerCheck(), this.intervalSec * 1000);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    // Bounded stop: let an already-running check finish so its report and
    // alerts are not lost, and so no timer survives the shutdown.
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  /** Fire a check unless one is already running. Keeps polls non-overlapping. */
  private triggerCheck(): void {
    if (this.inFlight) {
      return;
    }
    const check = this.runCheck()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = check;
  }

  getHistory(): HealthReport[] {
    return [...this.history];
  }

  async runCheck(): Promise<HealthReport> {
    const report = await this.performCheck();
    this.history.push(report);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.alerter.updateMetrics(report);
    this.alerter.logAlerts(report);
    return report;
  }

  private async performCheck(): Promise<HealthReport> {
    const timestamp = new Date().toISOString();
    let healthy = true;
    let degraded = false;
    let ledgerSequence: number | null = null;
    let latencyMs = 0;
    let latencySpike = false;
    let stalled = false;
    let error: string | null = null;

    try {
      const healthResult = await this.rpcPost('getHealth');
      if (healthResult.status !== 'OK') {
        healthy = false;
        error = `RPC returned status: ${healthResult.status}`;
      }
    } catch (e) {
      healthy = false;
      error = `Health check failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      const start = Date.now();
      const ledgerResult = await this.rpcPost('getLatestLedger');
      latencyMs = Date.now() - start;

      if (latencyMs > LATENCY_SPIKE_MS) {
        latencySpike = true;
        this.alerter.recordLatencySpike(latencyMs);
      }

      const sequence = ledgerResult.sequence;
      if (typeof sequence === 'number' && Number.isFinite(sequence)) {
        ledgerSequence = sequence;
      } else if (typeof sequence === 'string' && sequence.trim() !== '' && Number.isFinite(Number(sequence))) {
        ledgerSequence = Number(sequence);
      }

      if (ledgerSequence !== null) {
        const now = Date.now();
        if (this.lastLedgerSequence !== null && this.lastLedgerTimestamp !== null) {
          if (ledgerSequence === this.lastLedgerSequence) {
            if (now - this.lastLedgerTimestamp > STALL_THRESHOLD_MS) {
              stalled = true;
              degraded = true;
              healthy = false;
              error = `Ledger stalled at sequence ${ledgerSequence} for more than 30s`;
              this.alerter.recordStall();
            }
          } else {
            this.lastLedgerTimestamp = now;
          }
        } else {
          this.lastLedgerTimestamp = now;
        }
        this.lastLedgerSequence = ledgerSequence;
      }
    } catch (e) {
      healthy = false;
      latencyMs = 0;
      if (!error) {
        error = `Ledger check failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    return {
      timestamp,
      healthy,
      degraded,
      ledgerSequence,
      latencyMs,
      latencySpike,
      stalled,
      error,
    };
  }

  /**
   * Perform one JSON-RPC 2.0 call and return its `result` object.
   *
   * A compliant Soroban RPC endpoint answers with a full envelope
   * (`jsonrpc`, matching `id`, and either `result` or `error`), not a bare
   * result. Validate the envelope so protocol or transport faults surface as
   * errors instead of silently reading `undefined` fields.
   */
  private rpcPost(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = ++this.requestId;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const url = new URL(this.rpcUrl);
      const transport = url.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: this.requestTimeoutMs,
          // Each probe is independent; do not reuse pooled sockets, which can
          // be stale when an endpoint is restarted between checks.
          agent: false,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            res.resume();
            reject(new Error(`RPC HTTP error: ${statusCode}`));
            return;
          }

          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              reject(new Error('Invalid JSON response'));
              return;
            }
            try {
              resolve(this.extractResult(parsed as JsonRpcResponse, id));
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        },
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
      req.write(payload);
      req.end();
    });
  }

  private extractResult(response: JsonRpcResponse, expectedId: number): Record<string, unknown> {
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      throw new Error('Invalid JSON-RPC response: expected an object');
    }
    if (response.jsonrpc !== '2.0') {
      throw new Error('Invalid JSON-RPC response: missing or invalid jsonrpc version');
    }
    if (response.id !== expectedId) {
      throw new Error(`Invalid JSON-RPC response: expected id ${expectedId}, got ${String(response.id)}`);
    }
    if (response.error !== undefined) {
      const rpcError = response.error as Record<string, unknown> | null;
      const code = typeof rpcError?.code === 'number' ? rpcError.code : 'unknown';
      const message =
        typeof rpcError?.message === 'string' ? rpcError.message : 'Unknown JSON-RPC error';
      throw new Error(`JSON-RPC error ${code}: ${message}`);
    }
    if (
      typeof response.result !== 'object' ||
      response.result === null ||
      Array.isArray(response.result)
    ) {
      throw new Error('Invalid JSON-RPC response: missing result object');
    }
    return response.result as Record<string, unknown>;
  }
}
