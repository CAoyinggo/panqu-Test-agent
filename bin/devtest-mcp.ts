#!/usr/bin/env node
/**
 * Panqu AI DevTest v6.0.0 IDE 辅助 MCP 服务 (stdio JSON-RPC)
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DevTestMcpService, DEVTEST_MCP_TOOL, DEVTEST_RECORD_CANDIDATE_TOOL } from '../src/devtest/mcp-service.js';
import { PLATFORM_VERSION } from '../src/devtest/version.js';

export interface McpRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export async function processMcpRequest(
  service: DevTestMcpService,
  request: McpRpcRequest,
): Promise<McpRpcResponse | null> {
  if (request.id === undefined) return null;
  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'devtest', version: PLATFORM_VERSION },
      },
    };
  }
  if (request.method === 'ping') {
    return { jsonrpc: '2.0', id: request.id, result: {} };
  }
  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: [DEVTEST_MCP_TOOL, DEVTEST_RECORD_CANDIDATE_TOOL] },
    };
  }
  if (request.method === 'tools/call') {
    const toolName = request.params?.name;
    const args = (request.params?.arguments as Record<string, unknown>) || {};
    if (
      toolName === 'devtest_record_candidate' ||
      toolName === 'record_knowledge_candidate' ||
      toolName === 'record_candidate'
    ) {
      const result = await service.recordCandidate(args);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: result.ok === false,
        },
      };
    }
    let action = args.action;
    if (toolName === 'devtest') {
      // use args.action as-is
    } else if (toolName === 'probe' || toolName === 'panqu_probe') {
      action = 'probe';
    } else if (toolName === 'plan' || toolName === 'panqu_plan') {
      action = 'plan';
    } else if (toolName === 'execute' || toolName === 'panqu_execute') {
      action = 'execute';
    } else if (toolName === 'verify' || toolName === 'panqu_verify') {
      action = 'verify';
    } else {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Unsupported method or tool; use devtest' },
      };
    }
    const result = await service.call({ ...args, action });
    const reportText = (result as any)?.report || (result as any)?.summary || JSON.stringify(result, null, 2);
    const isError = Boolean((result as any)?.isError ?? (result.ok === false && !(result as any)?.status));
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: reportText }],
        structuredContent: result,
        isError,
      },
    };
  }
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: 'Unsupported method or tool; use devtest' },
  };
}

/** stdio transport only. Reuses the current TEST_CASE_V2 kernel; never shells out with model input. */
export async function serveDevTestMcp(projectRoot = process.cwd()): Promise<void> {
  const service = new DevTestMcpService(projectRoot);
  const tasks = new Set<Promise<void>>();
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const handle = async (line: string): Promise<void> => {
    let request: McpRpcRequest;
    try {
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error('request too large');
      request = JSON.parse(line);
      if (!request || typeof request !== 'object') throw new Error('invalid request');
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' } });
      return;
    }
    const response = await processMcpRequest(service, request);
    if (response) {
      send(response);
    }
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const pending = handle(line).catch(() => {
      send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    });
    tasks.add(pending);
    void pending.finally(() => tasks.delete(pending));
  }
  await Promise.all(tasks);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--project-root'))
    throw new Error('Usage: devtest-mcp [--project-root <repository>]');
  // Keep third-party runtime diagnostics off the JSON-RPC channel.
  console.log = (...values: unknown[]) => console.error(...values);
  await serveDevTestMcp(args[1]);
}
