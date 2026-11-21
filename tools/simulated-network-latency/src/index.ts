#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { LatencyProxy } from './proxy';
import type { ProxyConfig } from './types';

const program = new Command();

program
  .name('simulated-network-latency')
  .description('Mock Stellar RPC proxy that injects configurable network latency and fault conditions')
  .version('0.0.1')
  .requiredOption('--target <url>', 'Upstream Soroban RPC URL to forward requests to')
  .option('--port <number>', 'Local port to listen on', '8899')
  .option('--min-latency <ms>', 'Minimum injected latency in ms', '0')
  .option('--max-latency <ms>', 'Maximum injected latency in ms', '0')
  .option('--fault-rate <rate>', 'Fraction of requests (0-1) to fail outright', '0')
  .option('--fault-status <code>', 'HTTP status code for faulted requests', '503')
  .option('--max-body-bytes <bytes>', 'Maximum request/response body size in bytes', '1048576')
  .option('--max-log-entries <n>', 'Maximum in-memory request log entries', '100')
  .option('--upstream-timeout-ms <ms>', 'Upstream request timeout in milliseconds', '10000')
  .action(async (options) => {
    const config: ProxyConfig = {
      targetRpcUrl: options.target,
      port: parseInt(options.port, 10),
      minLatencyMs: parseInt(options.minLatency, 10),
      maxLatencyMs: parseInt(options.maxLatency, 10),
      faultRate: parseFloat(options.faultRate),
      faultStatusCode: parseInt(options.faultStatus, 10),
      maxBodyBytes: parseInt(options.maxBodyBytes, 10),
      maxLogEntries: parseInt(options.maxLogEntries, 10),
      upstreamTimeoutMs: parseInt(options.upstreamTimeoutMs, 10),
    };

    const proxy = new LatencyProxy(config);
    await proxy.start();
    console.log(
      chalk.green(`✓ Proxying to ${config.targetRpcUrl} on http://localhost:${config.port}`),
    );
    console.log(
      chalk.gray(
        `  latency: ${config.minLatencyMs}-${config.maxLatencyMs}ms, fault rate: ${config.faultRate * 100}%`,
      ),
    );

    process.on('SIGINT', async () => {
      await proxy.stop();
      process.exit(0);
    });
  });

program.parse();
