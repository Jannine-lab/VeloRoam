/** Explainable preliminary recommendation score; unknown signals remain unknown. */
export interface SegmentScoreInput {
  distanceKm: number | null;
  avgGrade: number | null;
  starCount: number | null;
  athleteCount: number | null;
  effortCount: number | null;
}
export interface SegmentScoreResult {
  version: 'v1'; total: number | null; popularity: number | null;
  distance: number | null; climbing: number | null; availableWeight: number;
}
const valid = (n: number | null): n is number => n !== null && Number.isFinite(n);
const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Missing dimensions are excluded, rather than treated as zero. */
export function calculateSegmentScore(input: SegmentScoreInput): SegmentScoreResult {
  const signals: Array<[number | null, number, number]> = [
    [input.athleteCount, 1000, 0.5], [input.effortCount, 5000, 0.3], [input.starCount, 100, 0.2]
  ];
  let popularitySum = 0;
  let popularityWeight = 0;
  for (const [count, reference, weight] of signals) {
    if (valid(count) && count >= 0) {
      popularitySum += clamp(100 * Math.log1p(count) / Math.log1p(reference)) * weight;
      popularityWeight += weight;
    }
  }
  const popularity = popularityWeight ? round(popularitySum / popularityWeight) : null;
  const distance = valid(input.distanceKm) && input.distanceKm >= 0
    ? round(clamp(input.distanceKm / 10 * 100)) : null;
  // Challenge indicator, not a safety or road-quality assessment.
  const climbing = valid(input.avgGrade) ? round(clamp(Math.max(0, input.avgGrade) / 8 * 100)) : null;
  const dimensions: Array<[number | null, number]> = [[popularity, 0.5], [distance, 0.3], [climbing, 0.2]];
  let sum = 0;
  let availableWeight = 0;
  for (const [score, weight] of dimensions) {
    if (score !== null) { sum += score * weight; availableWeight += weight; }
  }
  return { version: 'v1', total: availableWeight ? round(sum / availableWeight) : null,
    popularity, distance, climbing, availableWeight: round(availableWeight) };
}
