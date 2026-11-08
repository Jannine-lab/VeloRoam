/** Real model evaluation with deterministic read tools and a stub planner; no live navigation or writes. */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Request, Response } from 'express';
import { Candidate, createIdeaController } from '../controllers/ideaController';
import { IDEA_PROMPT_VERSION } from '../prompts/ideaPrompts';
import { unknownRouteTags } from '../services/ideaTagPreferences';
import { IDEA_EVAL_CASES, IDEA_EVAL_DATASET_VERSION } from './ideaEvalCases';
import { evaluateIdeaTurn, IdeaEvalCase, percentile } from './ideaEvaluation';
import { pool } from '../config/db';

const center = { lat: 31.2, lng: 121.4 };
const fixtures: Candidate[] = [
  { id: 'segment:101', type: 'segment', name: '滨江练习段', ...center, distanceKm: 10, hazardous: false, tags: { ...unknownRouteTags(), popular: 'matched' }, coordinates: [center, { lat: 31.21, lng: 121.41 }] },
  { id: 'segment:102', type: 'segment', name: '城市绕圈段', ...center, distanceKm: 12, hazardous: false, tags: { ...unknownRouteTags(), loop: 'matched' }, coordinates: [center, { lat: 31.22, lng: 121.42 }] },
  { id: 'point:201', type: 'point', name: '补给咖啡站', category: 'supply', ...center }
];
function fixtureController() {
  return createIdeaController({
    // No model/toolCaller override: production DeepSeek and bindTools are exercised.
    search: async name => name === '滨江' ? fixtures.slice(0, 2) : fixtures.filter(item => item.name === name),
    resolve: async name => ['人民广场', '世纪公园'].includes(name) ? center : null,
    near: async () => fixtures,
    plan: async intent => ({ message: '已完成需求解析（固定规划器评测）', items: [], route: {
      legs: [], stops: [], distanceKm: intent.targetKm ?? intent.maxKm ?? 30, durationMin: intent.targetMinutes ?? 90, hasEstimatedTime: true
    } })
  });
}
async function runCase(sample: IdeaEvalCase, repeat: number) {
  const controller = fixtureController();
  const history: Array<{ role: string; content: string }> = [];
  let previousIntent: unknown = null; let placeContext: unknown = null;
  const turns: Array<Record<string, any>> = [];
  for (const turn of sample.turns) {
    const started = performance.now(); let status = 200; let body: any;
    const req = { body: { idea: turn.idea, center, origin: center, originSource: 'manual', history, previousIntent, placeContext }, get: () => '' } as unknown as Request;
    const res = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } } as unknown as Response;
    try { await controller(req, res); }
    catch { status = 500; body = { error: 'evaluation_request_failed' }; }
    const checks = evaluateIdeaTurn(status, body, turn.expect);
    turns.push({ idea: turn.idea, expected: turn.expect, status, durationMs: Math.round(performance.now() - started), checks, response: body });
    previousIntent = body?.contextIntent; placeContext = body?.placeContext;
    history.push({ role: 'user', content: turn.idea }, { role: 'assistant', content: body?.message || body?.error || '' });
  }
  const passed = turns.every(turn => turn.checks.every((check: { passed: boolean }) => check.passed));
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${sample.id} [${repeat}]${passed ? '' : ': ' + turns.flatMap(turn => turn.checks.filter((check: { passed: boolean }) => !check.passed).map((check: { name: string }) => check.name)).join(', ')}\n`);
  return { id: sample.id, category: sample.category, split: sample.split, repeat, passed, turns };
}
export async function runIdeaEvaluation() {
  const args = process.argv.slice(2);
  const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const limit = Number(option('limit') || 60); const repeats = Number(option('repeat') || 1); const concurrency = Number(option('concurrency') || 2);
  if (![limit, repeats, concurrency].every(Number.isInteger) || limit < 1 || limit > 60 || repeats < 1 || repeats > 5 || concurrency < 1 || concurrency > 4) throw new Error('Invalid evaluation bounds');
  const split = option('split'); const ids = option('ids')?.split(',');
  if (split && !['development', 'holdout'].includes(split)) throw new Error('Invalid dataset split');
  const samples = IDEA_EVAL_CASES.filter(item => (!split || item.split === split) && (!ids || ids.includes(item.id))).slice(0, limit);
  if (!samples.length) throw new Error('No matching scenarios');
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for real model evaluation');
  const output = resolve(option('output') || `reports/idea-eval/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const implementationFiles = ['../controllers/ideaController.ts', '../services/ideaModel.ts', '../services/ideaToolAgent.ts', '../prompts/ideaPrompts.ts',
    '../services/ideaAgentGraph.ts', '../services/ideaIntent.ts', '../services/ideaTagPreferences.ts', './ideaEvaluation.ts', './ideaEvalCases.ts'];
  const implementationHash = () => hash(implementationFiles.map(file => readFileSync(resolve(__dirname, file), 'utf8')).join('\n'));
  const initialImplementationHash = implementationHash();
  mkdirSync(resolve(output, '..'), { recursive: true });
  mkdirSync(output, { recursive: false });
  const jobs = samples.flatMap(sample => Array.from({ length: repeats }, (_, index) => ({ sample, repeat: index + 1 })));
  let cursor = 0; const results: Awaited<ReturnType<typeof runCase>>[] = [];
  const startedAt = new Date().toISOString(); const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]!; results.push(await runCase(job.sample, job.repeat));
      writeFileSync(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
    }
  }));
  const turns = results.flatMap(result => result.turns);
  const checks = turns.flatMap(turn => turn.checks as Array<{ name: string; passed: boolean }>);
  const rate = (items: Array<{ passed: boolean }>) => ({ passed: items.filter(x => x.passed).length, total: items.length, rate: items.length ? items.filter(x => x.passed).length / items.length : null });
  const toolCalls = turns.flatMap(turn => turn.response?.meta?.toolCalls || []);
  const completedTurns = turns.filter(turn => turn.status === 200 && !turn.response?.error);
  const summary = {
    mode: 'real-model-fixed-tools-and-stub-planner', datasetVersion: IDEA_EVAL_DATASET_VERSION, datasetHash: hash(JSON.stringify(IDEA_EVAL_CASES)),
    implementationHash: initialImplementationHash, implementationChangedDuringRun: initialImplementationHash !== implementationHash(),
    promptVersion: IDEA_PROMPT_VERSION, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', node: process.version,
    startedAt, completedAt: new Date().toISOString(), wallMs: Math.round(performance.now() - started), concurrency, repeats,
    uniqueScenarios: samples.length, scenarioResults: rate(results), turnResults: rate(turns.map(turn => ({ passed: turn.checks.every((check: { passed: boolean }) => check.passed) }))),
    checks: rate(checks), fieldChecks: rate(checks.filter(check => check.name.startsWith('field:'))),
    toolSelectionChecks: rate(checks.filter(check => check.name === 'tool_selection')),
    categories: Object.fromEntries([...new Set(results.map(result => result.category))].map(category => [category, rate(results.filter(result => result.category === category))])),
    splits: Object.fromEntries(['development', 'holdout'].map(group => [group, rate(results.filter(result => result.split === group))])),
    latencyMs: { allTurnsP50: percentile(turns.map(turn => turn.durationMs), .5), allTurnsP95: percentile(turns.map(turn => turn.durationMs), .95),
      completedTurnsP50: percentile(completedTurns.map(turn => turn.durationMs), .5), completedTurnsP95: percentile(completedTurns.map(turn => turn.durationMs), .95) },
    usage: { modelCalls: turns.reduce((sum, turn) => sum + (turn.response?.meta?.modelCalls || 0), 0), inputTokens: turns.reduce((sum, turn) => sum + (turn.response?.meta?.inputTokens || 0), 0), outputTokens: turns.reduce((sum, turn) => sum + (turn.response?.meta?.outputTokens || 0), 0), toolCalls: toolCalls.length, toolErrors: toolCalls.filter(call => !['ok', 'cached'].includes(call.status)).length },
    limitations: ['Synthetic business cases with rule-based expected fields and tool identity checks.', 'Uses real model API and native function calling, but fixed retrieval fixtures and a stub route planner.', 'Does not measure live database/map availability, route quality, semantic correctness of general knowledge answers, or production user success.', 'A single repetition is not a stability benchmark; sample size, concurrency and prompt/model versions must accompany latency and success figures.']
  };
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ report: output, ...summary }, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
}
if (require.main === module) runIdeaEvaluation().catch(() => { console.error('评测未完成，请检查配置、参数或输出目录。'); process.exitCode = 1; }).finally(() => pool.end());
