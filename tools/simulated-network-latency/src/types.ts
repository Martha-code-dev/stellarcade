export interface ProxyConfig {
  targetRpcUrl: string;
  port: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  faultRate: number; // 0-1, probability a request fails outright
  faultStatusCode: number;
  maxBodyBytes?: number;
  maxLogEntries?: number;
  upstreamTimeoutMs?: number;
}

export interface RequestLogEntry {
  method: string;
  latencyMs: number;
  faulted: boolean;
  timestamp: string;
  statusCode?: number;
  error?: string;
}
