#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DevTestMcpService, DEVTEST_MCP_TOOL } from '../src/devtest/mcp-service.js';
import { PLATFORM_VERSION } from '../src/platform/version.js';

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
      response({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'devtest', version: PLATFORM_VERSION } });
    } else if (request.method === 'ping') response({});
    else if (request.method === 'tools/list') response({ tools: [DEVTEST_MCP_TOOL] });
    else if (request.method === 'tools/call') {
      const toolName = request.params?.name;
      const args = (request.params?.arguments as Record<string, unknown>) || {};
      let action = args.action;
      if (toolName === 'devtest') {
        // use args.action as-is
      } else if (toolName === 'quick_verify' || toolName === 'panqu_model_quick_verify') {
        action = 'quick_verify';
      } else if (toolName === 'audit_billing' || toolName === 'panqu_audit_billing_ledger') {
        action = 'audit_billing';
      } else if (toolName === 'diagnose_diversion' || toolName === 'panqu_diversion_rule_diagnose') {
        action = 'diagnose_diversion';
      } else if (toolName === 'self_test_plan' || toolName === 'panqu_self_test_plan') {
        action = 'self_test_plan';
      } else if (toolName === 'probe_environment' || toolName === 'panqu_probe_environment') {
        action = 'probe_environment';
      } else if (toolName === 'export_repro' || toolName === 'panqu_export_repro_package') {
        action = 'export_repro';
      } else if (toolName === 'extract_model_matrix' || toolName === 'panqu_extract_model_matrix') {
        action = 'extract_model_matrix';
      } else if (toolName === 'analyze_git_impact' || toolName === 'panqu_analyze_git_impact') {
        action = 'analyze_git_impact';
      } else if (toolName === 'watch_task' || toolName === 'panqu_watch_task') {
        action = 'watch_task';
      } else if (toolName === 'simulate_chaos' || toolName === 'panqu_simulate_chaos') {
        action = 'simulate_chaos';
      } else if (toolName === 'audit_config_drift' || toolName === 'panqu_audit_config_drift') {
        action = 'audit_config_drift';
      } else if (toolName === 'audit_margin' || toolName === 'panqu_audit_margin') {
        action = 'audit_margin';
      } else if (toolName === 'review_pr' || toolName === 'panqu_review_pr' || toolName === 'run_ci_gate') {
        action = 'review_pr';
      } else if (toolName === 'export_ci_workflow' || toolName === 'panqu_export_ci_workflow') {
        action = 'export_ci_workflow';
      } else if (toolName === 'propose_fix_pr' || toolName === 'panqu_propose_fix_pr' || toolName === 'generate_fix_pr') {
        action = 'propose_fix_pr';
      } else if (toolName === 'report_check_run' || toolName === 'create_check_run' || toolName === 'panqu_check_run') {
        action = 'report_check_run';
      } else if (toolName === 'handle_pr_command' || toolName === 'pr_command' || toolName === 'panqu_pr_command') {
        action = 'handle_pr_command';
      } else if (toolName === 'post_merge_release' || toolName === 'close_issue_release' || toolName === 'panqu_release') {
        action = 'post_merge_release';
      } else {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported method or tool; use devtest' } });
        return;
      }
      const result = await service.call({ ...args, action });
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
