/** Real model tool-selection smoke test with synthetic data and stub planning; no map or database traffic. */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runIdeaToolAgent } from '../services/ideaToolAgent';
import { createIdeaMetrics } from '../services/ideaModel';
import { IDEA_PROMPT_VERSION } from '../prompts/ideaPrompts';
import type { Candidate } from '../controllers/ideaController';
import { pool } from '../config/db';

const center = { lat: 31.2, lng: 121.4 };
const candidate: Candidate = { id: 'segment:101', type: 'segment', name: '示例滨江绿道', ...center, score: 80,
  coordinates: [center, { lat: 31.21, lng: 121.41 }] };
const baseRoute = { legs: [], stops: [], distanceKm: 30, durationMin: 100, hasEstimatedTime: true };
async function run() {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required');
  const repeat = Number(process.argv.find(arg => arg.startsWith('--repeat='))?.slice('--repeat='.length) || 1);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error('repeat must be 1 to 5');
  const results = [];
  for (const scenario of ['nearby', 'confirmed-route'] as const) for (let iteration = 1; iteration <= repeat; iteration++) {
    const metrics = createIdeaMetrics(); const start = performance.now(); let planning = 0; let exploration = 0;
    try {
      const interpretation = await runIdeaToolAgent({ metrics,
        input: scenario === 'nearby' ? { idea: '请先查询当前位置5公里内有哪些骑行路段，再给我推荐。' } :
          { idea: '我已经确认骑30公里，经过沿江路段并寻找沿途顺路路段。请先规划，再探索顺路路段。', confirmed: true,
            previousIntent: { mode: 'route', targetKm: 30, needsSegment: true, preferences: ['沿途找绿道'] } },
        location: { point: center, source: 'manual' }, search: async () => [candidate], resolve: async () => center,
        nearby: async () => [candidate],
        ...(scenario === 'confirmed-route' ? {
          plan: async () => { planning++; return { route: baseRoute }; },
          explore: async () => { exploration++; return { status: 'explored' as const, added: ['示例绿道'], extraKm: .5,
            result: { route: { ...baseRoute, distanceKm: 30.5 } } }; }
        } : {})
      });
      const calls = metrics.toolCalls.map(item => ({ name: item.name, status: item.status, durationMs: item.durationMs }));
      const nearbyOk = calls.some(item => item.name === 'search_nearby_candidates' && ['ok', 'cached'].includes(item.status));
      const planOk = calls.some(item => item.name === 'plan_cycling_route' && item.status === 'ok') && planning === 1;
      const exploreOk = calls.some(item => item.name === 'find_enroute_segments' && item.status === 'ok') && exploration === 1;
      results.push({ scenario, iteration, passed: scenario === 'nearby' ? nearbyOk : planOk && exploreOk, mode: interpretation.mode, calls, planning, exploration, elapsedMs: Math.round(performance.now() - start) });
    } catch (error: any) {
      const rawCode = error?.cause?.code || error?.code;
      const code = typeof rawCode === 'string' && /^[A-Z_]{2,40}$/.test(rawCode) ? rawCode : null;
      results.push({ scenario, iteration, passed: false, error: 'model_request_failed', code, status: Number.isInteger(error?.status) ? error.status : null,
        calls: metrics.toolCalls, elapsedMs: Math.round(performance.now() - start) });
    }
  }
  const report = { mode: 'real-model-synthetic-tool-fixtures', promptVersion: IDEA_PROMPT_VERSION, results,
    limitations: ['Synthetic fixtures; no real database, routing, route quality or production latency.', 'A few repetitions are a smoke test, not a reliability benchmark.'] };
  const path = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
  if (path) writeFileSync(path, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  if (results.some(item => !item.passed)) process.exitCode = 1;
}
run().catch(() => { console.error('Tool smoke evaluation could not start.'); process.exitCode = 1; }).finally(() => pool.end());
