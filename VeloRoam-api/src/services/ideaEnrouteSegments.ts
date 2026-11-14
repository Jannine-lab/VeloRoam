import { LatLng, getDistanceMeters } from '../utils/polyline';
import { RouteBounds } from './ideaCandidatePlanner';
import { budgetReason, validateFixedStops } from './ideaAutonomousGenerator';
import { CompositeLeg, CompositeRoute, RouteStop, trajectoryDistanceKm } from './ideaRouteService';
import { estimateRouteOverlap } from './ideaRouteOverlap';
import { RouteTagStatuses } from './ideaIntent';
import { requestedRouteTags, tagPreferenceScore } from './ideaTagPreferences';

export interface EnrouteCandidate {
  id: string; type: 'point' | 'segment'; name: string; coordinates?: LatLng[];
  score?: number | null; hazardous?: boolean | null; tags?: RouteTagStatuses;
  averageGrade?: number | null; elevationGainM?: number | null; athleteCount?: number | null;
  effortCount?: number | null; recordedDistanceKm?: number | null;
}
type Preferences = ReturnType<typeof requestedRouteTags>;
type Gap = { index: number; leg: CompositeLeg };
type Choice = { gap: number; candidate: EnrouteCandidate; stop: RouteStop; rank: number };
export type EnrouteAlternative = { route: CompositeRoute; stops: RouteStop[]; added: string[]; extraKm: number };

// Projection onto each polyline edge handles sparse provider geometry, unlike nearest-vertex lookup.
function project(point: LatLng, points: LatLng[]): { distance: number; progress: number } {
  let best = Infinity, progress = 0, travelled = 0;
  const scaleX = 111200 * Math.cos(point.lat * Math.PI / 180), scaleY = 111200;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const ax = (a.lng - point.lng) * scaleX, ay = (a.lat - point.lat) * scaleY;
    const dx = (b.lng - a.lng) * scaleX, dy = (b.lat - a.lat) * scaleY;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || !length) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (length * length)));
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (distance < best) { best = distance; progress = travelled + t * length; }
    travelled += length;
  }
  return { distance: best, progress };
}
function pointAlong(points: LatLng[], fraction = .5): LatLng {
  const lengths = points.slice(1).map((p, i) => getDistanceMeters(points[i], p));
  const half = lengths.reduce((a, b) => a + b, 0) * fraction;
  let travelled = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (travelled + lengths[i] >= half && lengths[i] > 0) {
      const t = (half - travelled) / lengths[i];
      return { lat: points[i].lat + (points[i + 1].lat - points[i].lat) * t, lng: points[i].lng + (points[i + 1].lng - points[i].lng) * t };
    }
    travelled += lengths[i];
  }
  return points[0];
}
function gapsFor(route: CompositeRoute, stops: RouteStop[], end: LatLng): Gap[] {
  const gaps: Gap[] = [];
  let legIndex = 0;
  for (let index = 0; index <= stops.length; index++) {
    const target = index < stops.length ? stops[index].coordinates[0] : end;
    if (!target) return [];
    const leg = route.legs[legIndex];
    if (leg?.type === 'connection' && leg.points.length >= 2 && getDistanceMeters(leg.points[leg.points.length - 1], target) <= 100) {
      gaps.push({ index, leg }); legIndex++;
    }
    if (index < stops.length && stops[index].type === 'segment') {
      if (route.legs[legIndex]?.type !== 'segment') return [];
      legIndex++;
    }
  }
  return gaps;
}
function validGeometry(points: LatLng[]): boolean {
  return points.length >= 2 && points.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180) &&
    points.slice(1).every((p, i) => getDistanceMeters(p, points[i]) <= 500) && trajectoryDistanceKm(points) >= .3;
}
function toStop(candidate: EnrouteCandidate): RouteStop {
  return { type: 'segment', name: candidate.name, coordinates: candidate.coordinates!, detail: {
    id: candidate.id, averageGrade: candidate.averageGrade ?? null, elevationGainM: candidate.elevationGainM ?? null,
    athleteCount: candidate.athleteCount ?? null, effortCount: candidate.effortCount ?? null,
    hazardous: candidate.hazardous ?? null, recordedDistanceKm: candidate.recordedDistanceKm ?? null, tags: candidate.tags
  } };
}

/** Find a few promising directed segments along provider connections, then compare whole routes. */
export async function addEnrouteSegments(input: {
  baseline: CompositeRoute; stops: RouteStop[]; end: LatLng; bounds: RouteBounds; preferences: Preferences;
  overlapMode: 'minimize' | 'neutral';
  near: (center: LatLng) => Promise<EnrouteCandidate[]>;
  build: (stops: RouteStop[]) => Promise<CompositeRoute>;
  minimumScore?: number; onAlternative?: (result: EnrouteAlternative) => void; isCancelled?: () => boolean;
}): Promise<EnrouteAlternative> {
  const fallback = { route: input.baseline, stops: input.stops, added: [] as string[], extraKm: 0 };
  if (input.isCancelled?.()) return fallback;
  const availableGaps = gapsFor(input.baseline, input.stops, input.end).filter(g => g.leg.distanceKm >= 1 && g.leg.points.length >= 2);
  const longest = [...availableGaps].sort((a, b) => b.leg.distanceKm - a.leg.distanceKm)[0];
  const gaps = [...new Set([availableGaps[0], availableGaps[availableGaps.length - 1], longest].filter((g): g is Gap => !!g))];
  if (!gaps.length) return fallback;
  const fixedIds = new Set(input.stops.flatMap(s => s.detail?.id ? [s.detail.id] : []));
  const existingSegments = input.stops.filter(s => s.type === 'segment').map(s => s.coordinates);
  let searchFailures = 0;
  let searchCount = 0;
  const searches = await Promise.all(gaps.map(async gap => {
    const fractions = input.onAlternative && gap.leg.distanceKm > 30 ? [.2, .5, .8] : [.5];
    return (await Promise.all(fractions.map(async fraction => {
      searchCount++;
      try { return await input.near(pointAlong(gap.leg.points, fraction)); } catch { searchFailures++; return []; }
    }))).flat();
  }));
  if (input.onAlternative && searchFailures === searchCount) throw new Error('enroute_search_unavailable');
  if (input.isCancelled?.()) return fallback;
  const choices: Choice[] = [];
  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i];
    for (const c of searches[i]) {
      const points = c.coordinates || [];
      const fit = tagPreferenceScore(c, input.preferences);
      if (c.type !== 'segment' || c.hazardous === true || fixedIds.has(c.id) || !validGeometry(points) ||
          input.preferences.avoid.some(tag => c.tags?.[tag] === 'matched') || fit < 0 ||
          (input.minimumScore != null && (typeof c.score !== 'number' || !Number.isFinite(c.score) || c.score < input.minimumScore)) ||
          (!(typeof c.score === 'number' && Number.isFinite(c.score) && c.score > 0) && fit <= 0)) continue;
      const a = project(points[0], gap.leg.points), b = project(points[points.length - 1], gap.leg.points);
      if (a.distance > 1500 || b.distance > 1500 || b.progress <= a.progress + 100) continue;
      // Avoid inserting a duplicate of a fixed segment under a different ID.
      if (existingSegments.some(existing => points.filter(p => project(p, existing).distance <= 30).length / points.length >= .6)) continue;
      choices.push({ gap: gap.index, candidate: c, stop: toStop(c), rank: fit * 100 + Math.min(200, Math.max(0, c.score ?? 0)) - (a.distance + b.distance) / 1000 });
    }
  }
  choices.sort((a, b) => b.rank - a.rank || a.candidate.id.localeCompare(b.candidate.id));
  const sameSegment = (a: Choice, b: Choice) => {
    const x = a.stop.coordinates, y = b.stop.coordinates;
    const xLength = trajectoryDistanceKm(x), yLength = trajectoryDistanceKm(y);
    return getDistanceMeters(x[0], y[0]) < 30 && getDistanceMeters(x[x.length - 1], y[y.length - 1]) < 30 &&
      Math.abs(xLength - yLength) <= Math.max(.1, Math.max(xLength, yLength) * .1) &&
      project(x[Math.floor(x.length / 2)], y).distance < 30 && project(y[Math.floor(y.length / 2)], x).distance < 30;
  };
  const seen = new Set<string>();
  const uniqueChoices: Choice[] = [];
  const byGap = new Map<number, number>();
  const shortlisted = choices.filter(c => {
    if (seen.has(c.candidate.id) || (byGap.get(c.gap) || 0) >= 2 || (input.onAlternative && uniqueChoices.some(choice => sameSegment(choice, c)))) return false;
    seen.add(c.candidate.id); uniqueChoices.push(c); byGap.set(c.gap, (byGap.get(c.gap) || 0) + 1); return true;
  }).slice(0, 4);
  if (input.onAlternative && searchFailures && !shortlisted.length) throw new Error('enroute_search_unavailable');
  const maxExtra = Math.min(8, Math.max(2, input.baseline.distanceKm * .1));
  const baseOverlap = input.overlapMode === 'minimize' ? estimateRouteOverlap(input.baseline) : null;
  let routingFailures = 0;
  const evaluate = async (selected: Choice[]) => {
    if (input.isCancelled?.()) return null;
    const stops = input.stops.slice();
    for (const choice of [...selected].sort((a, b) => b.gap - a.gap)) stops.splice(choice.gap, 0, choice.stop);
    try {
      const route = await input.build(stops);
      if (budgetReason(route, input.bounds) || route.distanceKm > input.baseline.distanceKm + maxExtra || validateFixedStops(route, stops)) return null;
      const overlap = input.overlapMode === 'minimize' ? estimateRouteOverlap(route) : null;
      if (baseOverlap && overlap && overlap.fraction > baseOverlap.fraction + .1) return null;
      return { route, stops, selected };
    } catch { routingFailures++; return null; }
  };
  const completed: Array<Awaited<ReturnType<typeof evaluate>> | undefined> = Array(shortlisted.length).fill(undefined);
  const emitted: Choice[] = [];
  let nextToEmit = 0;
  const flush = () => {
    while (nextToEmit < completed.length && completed[nextToEmit] !== undefined) {
      const item = completed[nextToEmit++];
      if (!item || emitted.length >= 2 || emitted.some(previous => sameSegment(previous, item.selected[0]))) continue;
      emitted.push(item.selected[0]);
      if (!input.isCancelled?.()) input.onAlternative?.({ route: item.route, stops: item.stops, added: item.selected.map(choice => choice.candidate.name), extraKm: item.route.distanceKm - input.baseline.distanceKm });
    }
  };
  const singles = (await Promise.all(shortlisted.map(async (choice, index) => {
    const result = await evaluate([choice]);
    completed[index] = result; flush(); return result;
  }))).filter((x): x is NonNullable<typeof x> => x !== null);
  if (input.onAlternative && shortlisted.length && routingFailures === shortlisted.length) throw new Error('enroute_navigation_unavailable');
  if (!singles.length) return fallback;
  singles.sort((a, b) => b.selected[0].rank - a.selected[0].rank || a.route.distanceKm - b.route.distanceKm);
  let selected = singles[0];
  if (input.onAlternative) return { route: selected.route, stops: selected.stops, added: selected.selected.map(c => c.candidate.name), extraKm: selected.route.distanceKm - input.baseline.distanceKm };
  const other = singles.find(x => x.selected[0].gap !== selected.selected[0].gap && x.selected[0].candidate.id !== selected.selected[0].candidate.id);
  if (other) selected = await evaluate([selected.selected[0], other.selected[0]]) || selected;
  return { route: selected.route, stops: selected.stops, added: selected.selected.map(c => c.candidate.name), extraKm: selected.route.distanceKm - input.baseline.distanceKm };
}
