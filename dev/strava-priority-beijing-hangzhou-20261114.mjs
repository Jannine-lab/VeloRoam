import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = '/Users/jannine/Desktop/VeloRoam';
const api = path.join(root, 'VeloRoam-api');
const statePath = path.join(root, 'dev/strava-priority-beijing-hangzhou-20261114.json');
const cities = ['beijing', 'hangzhou'];
const precedingPid = process.argv[2] === undefined ? null : Number(process.argv[2]);
if (precedingPid !== null && (!Number.isSafeInteger(precedingPid) || precedingPid <= 0)) throw new Error('Invalid preceding PID');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function state(status, extra = {}) {
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ status, updatedAt: new Date().toISOString(), ...extra }, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}
function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/local/bin/node', ['--require', 'ts-node/register/transpile-only', script, ...args], {
      cwd: api, env: process.env, stdio: ['ignore', 'inherit', 'inherit']
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
function readReport(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const results = [];
try {
  if (precedingPid !== null) {
    state('waiting_for_active_beijing', { precedingPid, results });
    while (true) {
      try { process.kill(precedingPid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await sleep(10000);
    }
    const previousReport = readReport(path.join(root, 'dev/strava-beijing-z13-2026-11-10/detail-import-priority-20261114-foreground.json'));
    if (previousReport?.stopped) {
      state('stopped', { city: 'beijing', precedingPid, reason: 'The preceding Beijing import stopped', results });
      process.exit(1);
    }
  }
  for (const city of cities) {
    const dir = path.join(root, `dev/strava-${city}-z13-2026-11-10`);
    const input = path.join(dir, 'candidates.json');
    let attempt = 0;
    while (true) {
      attempt++;
      const reportPath = path.join(dir, `detail-import-priority-20261114-attempt${attempt}.json`);
      state('importing', { city, attempt, reportPath, results });
      const exit = await run('src/scripts/importStravaTileSegments.ts', [
        `--input=${input}`, `--report=${reportPath}`, '--apply', '--wait-for-quota', '--interval-ms=2000'
      ]);
      const report = readReport(reportPath);
      if (report?.stopped || exit.signal) {
        state('stopped', { city, attempt, reportPath, exit, results });
        process.exit(1);
      }
      if (report?.status === 'complete' || (report?.status === 'failed' && report.failed?.length)) {
        const failures = report.failed || [];
        const connectionFailed = failures.some(item => /connection (lost|closed|reset)|ECONNRESET|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|ECONNREFUSED/i.test(item.reason));
        if (!connectionFailed) {
          results.push({ city, attempt, reportPath, imported: report.imported.length, failed: failures.length });
          break;
        }
      }
      state('waiting_to_retry', { city, attempt, reportPath, exit, results, retryAt: new Date(Date.now() + 300000).toISOString() });
      await sleep(300000);
    }
  }
  state(results.some(x => x.failed) ? 'needs_attention' : 'complete', { results });
} catch (error) {
  state('failed', { error: error.message, results });
  console.error(error);
  process.exitCode = 1;
}
