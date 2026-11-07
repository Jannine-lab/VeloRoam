export interface SegmentDisplayInput {
  stravaScore?: number | null;
  rawScore?: number | null;
  starCount?: number | null;
  effortCount?: number | null;
  distanceKm?: number | null;
  coordinates?: Array<{ lat: number; lng: number }>;
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function getSegmentDisplayScore(segment: SegmentDisplayInput): number | null {
  if (finiteNumber(segment.stravaScore)) return segment.stravaScore;
  return finiteNumber(segment.rawScore) ? segment.rawScore : null;
}

/** A conservative indicator of long, repeated movement inside a very small area. */
export function isCompactRepeatedSegment(segment: SegmentDisplayInput): boolean {
  if (!finiteNumber(segment.distanceKm) || segment.distanceKm < 1 || !segment.coordinates || segment.coordinates.length < 2) return false;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const point of segment.coordinates) {
    if (!finiteNumber(point.lat) || !finiteNumber(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return false;
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
  }
  // Longitude wraps at the antimeridian: skip that unusual case rather than guessing.
  if (maxLng - minLng > 180) return false;
  const height = (maxLat - minLat) * 111320;
  const width = (maxLng - minLng) * 111320 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
  const diagonal = Math.hypot(width, height);
  return diagonal > 0 && diagonal <= 500 && segment.distanceKm * 1000 >= Math.max(1000, 4 * diagonal);
}

/** Show progressively lower-scoring segments as the map is zoomed in. */
export function getSegmentVisibleFromZoom(segment: SegmentDisplayInput): number {
  const score = getSegmentDisplayScore(segment);
  if (score === null || score < 30) return 13;
  if (score < 80) return 12;
  if (score < 100) return 11;

  const meetsPopularity = (finiteNumber(segment.starCount) && segment.starCount >= 5)
    || (finiteNumber(segment.effortCount) && segment.effortCount >= 10);
  return meetsPopularity && !isCompactRepeatedSegment(segment) ? 10 : 11;
}
