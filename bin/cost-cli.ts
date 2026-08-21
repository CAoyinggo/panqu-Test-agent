#!/usr/bin/env node
// Phase 52 CLI：与 HTTP API 共用 CostGovernanceService 状态与策略语义。
import path from 'node:path';
import {
  CostGovernanceService,
  forecastCapacity,
  paretoFrontier,
  type CapacitySample,
} from '../src/cost/governance.js';

const args = process.argv.slice(2);
if (args[0] === 'agent') args.shift();
const stateFile = process.env.COST_GOVERNANCE_STATE ?? path.resolve('.data/cost-governance.json');
const service = CostGovernanceService.loadFromFile(stateFile);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const numeric = (flag: string): number | undefined => { const raw = value(flag); return raw === undefined ? undefined : Number(raw); };
const output = (data: unknown): void => { process.stdout.write(`${JSON.stringify(data, null, 2)}\n`); };
const persist = (): void => service.persistToFile(stateFile);

const [area, command, id] = args;
switch (`${area}:${command}`) {
  case 'cost:summary': output(service.summary({ window: (value('--window') ?? '7d') as never })); break;
  case 'cost:project': output({ projectId: id, ...service.summary({ projectId: id, window: (value('--window') ?? '7d') as never }) }); break;
  case 'cost:forecast': {
    const records = service.ledger.list();
    const grouped = new Map<string, CapacitySample>();
    for (const record of records) { const day = record.timestamp.slice(0, 10); const sample = grouped.get(day) ?? { timestamp: `${day}T00:00:00.000Z`, runs: 0, cost: 0, queuePeak: 0, workersPeak: 1 }; sample.cost += record.totalCost; sample.runs += record.runId ? 1 : 0; grouped.set(day, sample); }
    output((['1h', '6h', '24h', '7d', '30d'] as const).map((horizon) => forecastCapacity([...grouped.values()], horizon)));
    break;
  }
  case 'cost:anomalies': output(service.anomalies); break;
  case 'budget:list': output(service.budgets.list(value('--project'))); break;
  case 'budget:set': {
    const budget = service.setBudget({ projectId: value('--project'), daily: numeric('--daily'), weekly: numeric('--weekly'), monthly: numeric('--monthly'), perRun: numeric('--per-run'), perEvaluation: numeric('--per-evaluation'), perRelease: numeric('--per-release') }, value('--actor') ?? 'cli-human');
    persist(); output(budget); break;
  }
  case 'workers:capacity': output({ ...service.scaling(), policy: { minWorkers: 1, maxWorkers: 20, maxConcurrentJobs: 4 } }); break;
  case 'workers:scale': {
    const currentWorkers = numeric('--current') ?? service.scaling().currentWorkers;
    const decision = service.scale({ queueLength: numeric('--queue') ?? 0, oldestQueueAgeMs: numeric('--queue-age-ms') ?? 0, utilization: numeric('--utilization') ?? 0, priority: numeric('--priority') ?? 0, estimatedCost: numeric('--estimated-cost') ?? 0, currentWorkers }, { minWorkers: numeric('--min') ?? 1, maxWorkers: numeric('--max') ?? 20, jobsPerWorker: numeric('--jobs-per-worker') ?? 20, scaleUpQueueAgeMs: numeric('--scale-up-age-ms') ?? 30_000, cooldownMs: numeric('--cooldown-ms') ?? 60_000 }, value('--actor') ?? 'cli-human');
    persist(); output(decision); break;
  }
  case 'model-policy:list': output(service.policies.list(value('--project'))); break;
  case 'model-policy:compare': {
    const points = service.ledger.list({ projectId: value('--project') }).filter((r) => r.model).map((r) => ({ id: r.model!, quality: Number(value('--quality') ?? 0), cost: r.totalCost, latencyMs: 0 }));
    output({ policies: service.policies.list(value('--project')), frontier: paretoFrontier(points) }); break;
  }
  case 'optimization:list': output(service.listOptimizations(value('--project'))); break;
  case 'optimization:approve': { const result = service.decideOptimization(id, 'APPROVED', value('--actor') ?? 'cli-human'); persist(); output(result); break; }
  case 'optimization:reject': { const result = service.decideOptimization(id, 'REJECTED', value('--actor') ?? 'cli-human'); persist(); output(result); break; }
  default:
    process.stderr.write('Usage: agent cost summary|project <id>|forecast|anomalies; agent budget list|set; agent workers capacity|scale; agent model-policy list|compare; agent optimization list|approve <id>|reject <id>\n');
    process.exitCode = 2;
}
