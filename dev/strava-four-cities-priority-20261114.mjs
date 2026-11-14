import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = '/Users/jannine/Desktop/VeloRoam';
const priorityFile = path.join(root, 'dev/strava-priority-beijing-hangzhou-20261114.json');
const stateFile = path.join(root, 'dev/strava-four-cities-priority-20261114.json');
const cities = ['xuzhou', 'taizhou', 'wuxi', 'suzhou'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function state(status, extra = {}) {
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ status, updatedAt: new Date().toISOString(), ...extra }, null, 2) + '\n');
  fs.renameSync(stateFile + '.tmp', stateFile);
}
function run(script, args) {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/local/bin/node', ['--require', 'ts-node/register/transpile-only', script, ...args], {
      cwd: path.join(root, 'VeloRoam-api'), env: process.env, stdio: ['ignore', 'inherit', 'inherit']
    });
    p.once('error', reject);
    p.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
const results = [];
try {
  state('waiting_for_beijing_hangzhou', { results });
  while (true) {
    const prior = read(priorityFile);
    if (prior.status === 'complete' || (prior.status === 'needs_attention' && ['beijing', 'hangzhou'].every(city => prior.results?.some(result => result.city === city)))) break;
    if (['failed', 'stopped', 'needs_attention'].includes(prior.status)) throw new Error(`Priority queue requires attention: ${prior.status}`);
    await sleep(30000);
  }
  for (const city of cities) {
    const dir = path.join(root, `dev/strava-${city}-z13-2026-11-14`);
    const input = path.join(dir, 'candidates.json');
    state('waiting_for_completed_scan', { city, results });
    while (true) {
      if (fs.existsSync(input) && fs.existsSync(path.join(dir, 'summary.json'))) {
        const summary = read(path.join(dir, 'summary.json'));
        if (summary.pending === 0 && summary.errors === 0) break;
      }
      await sleep(30000);
    }
    let detail, report, attempt = 0;
    while (true) {
      attempt++;
      report = path.join(dir, `detail-import-priority-20261114-attempt${attempt}.json`);
      state('importing', { city, attempt, report, results });
      const imported = await run('src/scripts/importStravaTileSegments.ts', [`--input=${input}`, `--report=${report}`, '--apply', '--wait-for-quota', '--interval-ms=2000']);
      detail = fs.existsSync(report) ? read(report) : null;
      if (imported.signal || detail?.stopped) throw new Error(`${city} import stopped: ${JSON.stringify(imported)}`);
      const connectionFailed = detail?.failed?.some(item => /connection (lost|closed|reset)|ECONNRESET|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|ECONNREFUSED/i.test(item.reason));
      if (detail && ['complete', 'failed'].includes(detail.status) && !connectionFailed && (detail.status === 'complete' || detail.failed?.length)) break;
      state('waiting_to_retry', { city, attempt, report, results });
      await sleep(300000);
    }
    const scoreReport = path.join(dir, 'score-backfill-priority-20261114.json');
    state('backfilling_scores', { city, results });
    const scores = await run('src/scripts/backfillStravaTileScores.ts', [`--input=${input}`, `--report=${scoreReport}`, '--apply']);
    if (scores.code !== 0 || scores.signal) throw new Error(`${city} score backfill needs attention: ${JSON.stringify(scores)}`);
    results.push({ city, report, scoreReport, imported: detail.imported?.length ?? 0, failed: detail.failed?.length ?? 0 });
  }
  state(results.some(result => result.failed) ? 'needs_attention' : 'complete', { results });
} catch (error) {
  state('needs_attention', { error: error.message, results });
  console.error(error);
  process.exitCode = 1;
}
