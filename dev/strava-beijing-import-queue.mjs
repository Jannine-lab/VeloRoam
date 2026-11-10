import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = '/Users/jannine/Desktop/VeloRoam';
const api = path.join(root, 'VeloRoam-api');
const output = path.join(root, 'dev/strava-beijing-z13-2026-11-10');
const precedingPid = Number(process.argv[2]);
if (!Number.isSafeInteger(precedingPid) || precedingPid <= 0) throw new Error('Expected the preceding import PID');
const statusPath = path.join(output, 'queue.json');
const update = (status, extra = {}) => {
  const tmp = statusPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ status, updatedAt: new Date().toISOString(), precedingPid, ...extra }, null, 2) + '\n');
  fs.renameSync(tmp, statusPath);
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const run = (script, args) => new Promise((resolve, reject) => {
  const child = spawn('/usr/local/bin/node', ['--require', 'ts-node/register/transpile-only', script, ...args], {
    cwd: api, env: process.env, stdio: ['ignore', 'inherit', 'inherit']
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

try {
  update('waiting_for_shanghai');
  while (alive(precedingPid)) await new Promise(resolve => setTimeout(resolve, 10000));
  update('importing_full');
  const result = await run('src/scripts/importStravaTileSegments.ts', [
    `--input=${path.join(output, 'candidates.json')}`,
    `--report=${path.join(output, 'detail-import-full.json')}`,
    '--apply', '--wait-for-quota', '--interval-ms=2000'
  ]);
  update('backfilling_scores', { importResult: result });
  const scores = await run('src/scripts/backfillStravaTileScores.ts', [
    `--input=${path.join(output, 'candidates.json')}`,
    `--report=${path.join(output, 'score-backfill-final.json')}`, '--apply'
  ]);
  update(result.code === 0 && scores.code === 0 ? 'complete' : 'needs_attention', { importResult: result, scoresResult: scores });
} catch (error) {
  update('failed', { error: error.message });
  console.error(error);
  process.exitCode = 1;
}
