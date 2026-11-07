/** Fill only missing Strava map scores from a decoded, deduplicated tile capture. */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../config/db';

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const inputs = args.filter(a => a.startsWith('--input='));
  const reports = args.filter(a => a.startsWith('--report='));
  if (inputs.length !== 1 || reports.length > 1 || args.filter(a => a === '--apply').length > 1
    || args.some(a => a !== '--apply' && !a.startsWith('--input=') && !a.startsWith('--report='))) {
    throw new Error('Usage: ts-node src/scripts/backfillStravaTileScores.ts --input=FILE [--report=FILE] [--apply]');
  }
  const inputFile = resolve(inputs[0].slice('--input='.length));
  const reportFile = resolve(reports.length ? reports[0].slice('--report='.length) : inputFile + '.scores-report.json');
  if (inputFile === reportFile) throw new Error('Input and report files must differ');
  const input = JSON.parse(readFileSync(inputFile, 'utf8'));
  if (input.source !== 'strava-map-vector-tile' || !Array.isArray(input.segments)) throw new Error('Expected decoded tile segments');
  const scores = new Map<string, number>();
  for (const row of input.segments) {
    const id = String(row.id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))
      || typeof row.tileScore !== 'number' || !Number.isFinite(row.tileScore) || row.tileScore < 0) {
      throw new Error('Invalid segment ID or tile score');
    }
    if (scores.has(id) && scores.get(id) !== row.tileScore) throw new Error(`Conflicting tile scores for ${id}`);
    scores.set(id, row.tileScore);
  }
  const conn = await pool.getConnection();
  const report = { mode: apply ? 'apply' : 'preview', source: inputFile,
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    sourceIds: scores.size, existing: 0, alreadyScored: 0, eligible: 0, updated: 0, verified: 0,
    updatedIds: [] as string[] };
  try {
    if (apply) await conn.beginTransaction();
    try {
      const ids = [...scores.keys()];
      for (let start = 0; start < ids.length; start += 200) {
        const chunk = ids.slice(start, start + 200);
        const marks = chunk.map(() => '?').join(',');
        const [before] = await conn.query<RowDataPacket[]>(
          `SELECT CAST(id AS CHAR) AS id,raw_score,strava_score FROM strava_segments WHERE id IN (${marks})${apply ? ' FOR UPDATE' : ''}`, chunk);
        report.existing += before.length;
        const eligible = before.filter(r => r.strava_score === null);
        report.eligible += eligible.length;
        report.alreadyScored += before.length - eligible.length;
        if (!apply || !eligible.length) continue;
        const updateIds = eligible.map(r => String(r.id));
        const cases = updateIds.map(() => 'WHEN ? THEN ?').join(' ');
        const params = updateIds.flatMap(id => [id, scores.get(id)!]);
        const [result] = await conn.query<ResultSetHeader>(
          `UPDATE strava_segments SET strava_score=CASE id ${cases} END WHERE id IN (${updateIds.map(() => '?').join(',')}) AND strava_score IS NULL`,
          [...params, ...updateIds]);
        report.updated += result.affectedRows;
        const [after] = await conn.query<RowDataPacket[]>(
          `SELECT CAST(id AS CHAR) AS id,raw_score,strava_score FROM strava_segments WHERE id IN (${marks})`, chunk);
        const originals = new Map(before.map(r => [String(r.id), r]));
        const targets = new Set(updateIds);
        for (const row of after) {
          const original = originals.get(String(row.id));
          if (!original || row.raw_score !== original.raw_score) throw new Error(`Custom score changed for ${row.id}`);
          if (targets.has(String(row.id))) {
            if (Number(row.strava_score) !== scores.get(String(row.id))) throw new Error(`Tile score mismatch for ${row.id}`);
            report.verified++;
            report.updatedIds.push(String(row.id));
          } else if (row.strava_score !== original.strava_score) {
            throw new Error(`Existing tile score changed for ${row.id}`);
          }
        }
      }
      if (apply && (report.updated !== report.eligible || report.verified !== report.updated)) throw new Error('Score backfill count mismatch');
      if (apply) await conn.commit();
    } catch (error) {
      if (apply) await conn.rollback();
      throw error;
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, updatedIds: undefined, report: reportFile }, null, 2));
  } finally {
    conn.release();
    await pool.end();
  }
}
run().catch(error => { console.error('[StravaTileScores]', error.message); process.exitCode = 1; });
