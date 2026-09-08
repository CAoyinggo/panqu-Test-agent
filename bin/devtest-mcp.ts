#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DevTestMcpService, DEVTEST_MCP_TOOL } from '../src/devtest/mcp-service.js';

/** stdio transport only. Reuses the current TEST_CASE_V2 kernel; never shells out with model input. */
export async function serveDevTestMcp(projectRoot = process.cwd()): Promise<void> {
  const service = new DevTestMcpService(projectRoot);
  const tasks = new Set<Promise<void>>();
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const handle = async (line: string): Promise<void> => {
    let request: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error('request too large');
      request = JSON.parse(line);
      if (!request || typeof request !== 'object') throw new Error('invalid request');
    } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' } }); return; }
    if (request.id === undefined) return;
    const response = (result: unknown) => send({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') {
      response({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'devtest', version: '4.29.2' } });
    } else if (request.method === 'ping') response({});
    else if (request.method === 'tools/list') response({ tools: [DEVTEST_MCP_TOOL] });
    else if (request.method === 'tools/call' && request.params?.name === 'devtest') {
      const result = await service.call(request.params.arguments);
      response({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false });
    } else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported method or tool; use devtest' } });
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const pending = handle(line).catch(() => { send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }); });
    tasks.add(pending);
    void pending.finally(() => tasks.delete(pending));
  }
  await Promise.all(tasks);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--project-root')) throw new Error('Usage: devtest-mcp [--project-root <repository>]');
  // Keep third-party runtime diagnostics off the JSON-RPC channel.
  console.log = (...values: unknown[]) => console.error(...values);
  await serveDevTestMcp(args[1]);
}
