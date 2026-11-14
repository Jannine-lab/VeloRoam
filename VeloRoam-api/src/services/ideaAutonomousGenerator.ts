import { LatLng, getDistanceMeters } from '../utils/polyline';
import { buildIdeaRoute, CompositeRoute, RouteStop } from './ideaRouteService';
import { RouteBounds } from './ideaCandidatePlanner';
import { estimateRouteOverlap } from './ideaRouteOverlap';
import { fetchAmapBicyclingCandidates } from './amapFewestSignalService';
import { SignalRouteCandidate } from './fewestSignalRanking';
import { sampleTrajectory, WaypointSample } from './ideaWaypointSampling';

export interface WaypointEvidence { name: string; proposed: LatLng; selected: LatLng; offsetMeters: number; seedPath: LatLng[]; samples: WaypointSample[]; preferredFraction: number; source: 'bicycling_route' }
export interface GeneratedAttempt {
  id: string; stops: RouteStop[]; route: CompositeRoute | null;
  status: 'accepted' | 'outside_budget' | 'unreachable' | 'unchanged'; reason: string; change?: { baselineId: string; waypoint: string; fromFraction: number; toFraction: number }; rank?: number; comparison?: string; samplingFailures?: Array<{ name: string; proposed: LatLng; seedPath: LatLng[]; samples: WaypointSample[] }>; waypoints?: WaypointEvidence[]; overlap?: { repeatedKm: number; fraction: number } | null;
}
export interface GeneratedRouteResult { selected: GeneratedAttempt | null; attempts: GeneratedAttempt[]; selectionReason?: string }
export interface GeneratorInput { start: LatLng; end: LatLng; focus?: LatLng | null; bounds: RouteBounds; targetKm: number; fixedSegment?: RouteStop | null; fixedStops?: RouteStop[]; overlapMode?: 'minimize' | 'neutral'; startLabel?: string; endLabel?: string }

type Build = typeof buildIdeaRoute;
type Navigate = (origin: LatLng, destination: LatLng) => Promise<SignalRouteCandidate[]>;
const cacheKey = (a: LatLng, b: LatLng) => `${a.lat.toFixed(6)},${a.lng.toFixed(6)}:${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
const radians = (degrees: number) => degrees * Math.PI / 180;
function offset(point: LatLng, eastKm: number, northKm: number): LatLng {
  return { lat: point.lat + northKm / 111.2, lng: point.lng + eastKm / (111.2 * Math.max(0.15, Math.cos(radians(point.lat)))) };
}
function stop(name: string, point: LatLng): RouteStop { return { type: 'point', name, coordinates: [point] }; }

/** Proposed coordinates are waypoints only; routing must connect and snap them before use. */
export function proposeWaypoints(input: GeneratorInput, index: number, scale = 1): RouteStop[] {
  const { start, focus, targetKm, fixedSegment } = input;
  const fixedStops = input.fixedStops?.length ? input.fixedStops : fixedSegment ? [fixedSegment] : [];
  if (fixedStops.length > 1 || (fixedStops.length === 1 && fixedStops[0].type === 'point')) {
    const first = fixedStops[0].coordinates[0];
    const lastStop = fixedStops[fixedStops.length - 1];
    const last = lastStop.coordinates[lastStop.type === 'segment' ? lastStop.coordinates.length - 1 : 0];
    const side = index % 2 ? -1 : 1;
    const radius = Math.max(.3, Math.min(15, targetKm * .13 * scale * (1 + (index % 3) * .25)));
    const before = offset({ lat: (start.lat + first.lat) / 2, lng: (start.lng + first.lng) / 2 }, radius * side, radius * .5);
    const after = offset({ lat: (input.end.lat + last.lat) / 2, lng: (input.end.lng + last.lng) / 2 }, -radius * side, -radius * .5);
    return [stop('固定途经点前自主点', before), ...fixedStops, stop('固定途经点后自主点', after)];
  }
  const singleSegment = fixedStops[0];
  if (singleSegment && singleSegment.type === 'segment' && singleSegment.coordinates.length >= 2) {
    const entry = singleSegment.coordinates[0];
    const exit = singleSegment.coordinates[singleSegment.coordinates.length - 1];
    const side = index % 2 ? -1 : 1;
    const radius = Math.max(.3, Math.min(15, targetKm * .13 * scale * (1 + (index % 3) * .25)));
    const before = offset({ lat: (start.lat + entry.lat) / 2, lng: (start.lng + entry.lng) / 2 }, radius * side, radius * .5);
    const after = offset({ lat: (input.end.lat + exit.lat) / 2, lng: (input.end.lng + exit.lng) / 2 }, -radius * side, -radius * .5);
    return [stop('路段前自主途经点', before), singleSegment, stop('路段后自主途经点', after)];
  }
  const angle = radians([30, 150, 270, 75, 195][index % 5]);
  if (focus && getDistanceMeters(start, focus) > 500) {
    const dx = (focus.lng - start.lng) * 111.2 * Math.cos(radians(start.lat));
    const dy = (focus.lat - start.lat) * 111.2;
    const length = Math.hypot(dx, dy) || 1;
    const side = index % 2 ? -1 : 1;
    const spread = Math.min(targetKm * .12 * scale, Math.max(1, targetKm * .08)) * (0.75 + (index % 3) * 0.25);
    const approach = Math.min(5, targetKm * .1, length * .4);
    const reference = offset(focus, -dx / length * approach, -dy / length * approach);
    const mid = offset(start, (dx - dx / length * approach) * .55 - dy / length * spread * side, (dy - dy / length * approach) * .55 + dx / length * spread * side);
    const turn = offset(reference, -dy / length * spread * side, dx / length * spread * side);
    return [stop('自主途经点 1', mid), stop('目标方向参考点附近', reference), stop('自主转向点', turn)];
  }
  const radius = Math.max(.5, Math.min(40, targetKm / 5 * scale));
  return [0, 1, 2].map((i) => {
    const bearing = angle + radians(i * 100);
    return stop(`自主途经点 ${i + 1}`, offset(start, Math.cos(bearing) * radius, Math.sin(bearing) * radius));
  });
}

/** Validate fixed stop identities, order and exact segment geometry in provider-built output. */
export function validateFixedStops(route: CompositeRoute, required: RouteStop[]): string | null {
  let markerIndex = 0, legIndex = 0;
  for (const stop of required) {
    const expected = stop.coordinates[0];
    const at = route.stops.findIndex((marker, i) => i >= markerIndex && marker.type === stop.type && marker.name === stop.name && getDistanceMeters(marker.point, expected) < 1);
    if (at < 0) return `未能验证固定途经顺序：${stop.name}`;
    markerIndex = at + 1;
    if (stop.type === 'segment') {
      const segment = route.legs.findIndex((leg, i) => i >= legIndex && leg.type === 'segment' && leg.name === stop.name && leg.points.length === stop.coordinates.length && leg.points.every((p, n) => getDistanceMeters(p, stop.coordinates[n]) < 1));
      if (segment < 0) return `未能验证指定路段轨迹或方向：${stop.name}`;
      legIndex = segment + 1;
    }
  }
  return null;
}

export function budgetReason(route: CompositeRoute, bounds: RouteBounds): string | null {
  const km = route.distanceKm;
  if (!Number.isFinite(km) || km <= 0) return '导航未返回有效里程';
  if (bounds.minKm != null && km + 1e-9 < bounds.minKm) return '低于里程下限';
  if (bounds.maxKm != null && km - 1e-9 > bounds.maxKm) return '超过里程上限';
  const duration = route.durationMin + (bounds.stopMinutes ?? 0);
  const hasTime = bounds.minMinutes != null || bounds.maxMinutes != null || bounds.targetMinutes != null;
  if (hasTime && (!Number.isFinite(route.durationMin) || route.durationMin <= 0)) return '导航未返回有效骑行时间';
  if (bounds.minMinutes != null && bounds.stopMinutes !== null && duration + 1e-9 < bounds.minMinutes) return '低于时间下限';
  if (bounds.maxMinutes != null && duration - 1e-9 > bounds.maxMinutes) return '超过时间上限';
  return null;
}

/** At most five candidates; all accepted geometry comes from the supplied routing provider. */
export async function generateAutonomousRoute(input: GeneratorInput, build: Build = buildIdeaRoute, navigate: Navigate = fetchAmapBicyclingCandidates): Promise<GeneratedRouteResult> {
  const attempts: GeneratedAttempt[] = [];
  const run = async (index: number, scale: number, shapeIndex = index, previous?: GeneratedAttempt, fraction = .85, changeName?: string) => {
    const proposed = proposeWaypoints(input, shapeIndex, scale);
    const waypoints: WaypointEvidence[] = [];
    let change: GeneratedAttempt['change'];
    const samplingFailures: Array<{ name: string; proposed: LatLng; seedPath: LatLng[]; samples: WaypointSample[] }> = [];
    const stops: RouteStop[] = [];
    const cache = new Map<string, SignalRouteCandidate[]>();
    const cachedNavigate: Navigate = async (a, b) => {
      const key = cacheKey(a, b);
      const existing = cache.get(key);
      if (existing) return existing;
      const routes = await navigate(a, b);
      cache.set(key, routes);
      return routes;
    };
    try {
      let anchor = input.start;
      for (const candidate of proposed) {
        if ((input.fixedStops || []).includes(candidate) || candidate === input.fixedSegment) {
          if (!candidate.coordinates.length || (candidate.type === 'segment' && candidate.coordinates.length < 2)) throw new Error('固定途经对象缺少有效坐标');
          stops.push(candidate);
          anchor = candidate.coordinates[candidate.type === 'segment' ? candidate.coordinates.length - 1 : 0];
          continue;
        }
        const target = candidate.coordinates[0];
        if (getDistanceMeters(anchor, target) < 5) {
          throw new Error('候选点过于接近前一位置');
        }
        const prior = previous?.waypoints?.find(item => item.name === candidate.name);
        let seedPath: LatLng[];
        let seed: SignalRouteCandidate | undefined;
        let searchTarget = target;
        if (prior) {
          seedPath = prior.seedPath;
          searchTarget = prior.proposed;
        } else {
          const routes = await cachedNavigate(anchor, target);
          const usable = routes.filter(route => route.points.length >= 2 && Number.isFinite(route.distanceKm) && route.distanceKm > 0 &&
            getDistanceMeters(route.points[0], anchor) <= 100 && getDistanceMeters(route.points[route.points.length - 1], target) <= 100)
            .sort((a, b) => a.distanceKm - b.distanceKm);
          seed = usable[0];
          if (!seed) throw new Error('候选位置无法吸附到可连接的骑行导航轨迹');
          seedPath = seed.points;
        }
        const focusLimit = candidate.name === '目标方向参考点附近' ? 300 : null;
        const desiredFraction = prior && changeName !== candidate.name ? prior.preferredFraction : fraction;
        const samples = sampleTrajectory(seedPath, searchTarget, anchor, desiredFraction, focusLimit);
        let chosen = samples.find(item => item.status === 'selected');
        if (prior && changeName !== candidate.name) {
          const same = samples.find(item => item.status !== 'rejected' && getDistanceMeters(item.point, prior.selected) < .1);
          if (chosen) { chosen.status = 'eligible'; chosen.reason = '保留基准方案的点位'; }
          if (!same) { samplingFailures.push({ name: candidate.name, proposed: searchTarget, seedPath, samples }); throw new Error('保留原点位时与前一位置冲突'); }
          same.status = 'selected'; chosen = same;
        }
        if (prior && changeName === candidate.name && chosen && getDistanceMeters(chosen.point, prior.selected) < 20) {
          const alternative = samples.filter(item => item.status !== 'rejected' && getDistanceMeters(item.point, prior.selected) >= 20)
            .sort((a, b) => Math.abs(a.fraction - fraction) - Math.abs(b.fraction - fraction))[0];
          if (alternative) { chosen.status = 'eligible'; chosen = alternative; chosen.status = 'selected'; }
          else { attempts.push({ id: `candidate-${index + 1}`, stops: previous!.stops, route: null, status: 'unchanged', reason: '该点没有可用的不同采样位置', waypoints: previous!.waypoints }); return; }
        }
        if (!chosen) { samplingFailures.push({ name: candidate.name, proposed: searchTarget, seedPath, samples }); throw new Error('导航轨迹中没有满足空间约束的候选点'); }
        chosen.reason = prior && changeName !== candidate.name ? '保留基准方案中的位置' :
          focusLimit != null && chosen.fraction !== fraction ? '优先保留目标方向，选择更接近参考位置的点' :
          previous ? (fraction > (prior?.preferredFraction ?? .85) ? '调整此点，沿原轨迹向外探索' : '调整此点，沿原轨迹向内探索') : '首轮选择轨迹中后段，保留后续调整空间';
        if (prior && changeName === candidate.name) change = { baselineId: previous!.id, waypoint: candidate.name, fromFraction: prior.samples.find(item => item.status === 'selected')?.fraction ?? prior.preferredFraction, toFraction: chosen.fraction };
        for (const sample of samples) if (sample.status === 'eligible') sample.reason = '符合空间约束，但离本次目标比例更远';
        const selected = chosen.point;
        const evidence: WaypointEvidence = { name: candidate.name, proposed: searchTarget, selected, offsetMeters: getDistanceMeters(searchTarget, selected), seedPath, samples, preferredFraction: chosen.fraction, source: 'bicycling_route' };
        waypoints.push(evidence);
        stops.push({ ...candidate, coordinates: [selected] });
        // A full provider result is reusable only if the selected point is its actual endpoint.
        if (seed && getDistanceMeters(seed.points[seed.points.length - 1], selected) < .01) cache.set(cacheKey(anchor, selected), [seed]);
        anchor = selected;
      }
      const route = await build(input.start, input.startLabel || '当前位置', input.end, input.endLabel || '返回起点', stops, cachedNavigate);
      const required = input.fixedStops?.length ? input.fixedStops : input.fixedSegment ? [input.fixedSegment] : [];
      const missing = validateFixedStops(route, required);
      const reason = missing || budgetReason(route, input.bounds);
      attempts.push({ id: `candidate-${index + 1}`, stops, route, status: missing ? 'unreachable' : reason ? 'outside_budget' : 'accepted', reason: reason || (required.length ? '满足预算及固定途经顺序' : '满足预算'), change, waypoints, overlap: estimateRouteOverlap(route) });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : '无法连接候选位置';
      // Keep both the unprocessed targets and any successfully resolved points for inspection.
      attempts.push({ id: `candidate-${index + 1}`, stops: [...stops, ...proposed.slice(stops.length)], route: null, status: 'unreachable', reason: reason.slice(0, 160), change, waypoints, samplingFailures });
    }
  };
  await Promise.all([0, 1, 2].map(i => run(i, 1)));
  const compareAccepted = (a: GeneratedAttempt, b: GeneratedAttempt) =>
    (input.overlapMode === 'neutral' ? 0 : a.overlap && b.overlap ? a.overlap.fraction - b.overlap.fraction : a.overlap ? -1 : b.overlap ? 1 : 0) ||
    (input.bounds.targetKm != null ? Math.abs(a.route!.distanceKm - input.bounds.targetKm) - Math.abs(b.route!.distanceKm - input.bounds.targetKm) : 0) ||
    (input.bounds.targetMinutes != null ? Math.abs(a.route!.durationMin + (input.bounds.stopMinutes ?? 0) - input.bounds.targetMinutes) - Math.abs(b.route!.durationMin + (input.bounds.stopMinutes ?? 0) - input.bounds.targetMinutes) : 0);
  const measured = attempts.filter(x => x.status === 'accepted').sort(compareAccepted)[0] ||
    attempts.filter(x => x.route && x.status === 'outside_budget').sort((a, b) => input.bounds.targetMinutes != null && input.bounds.targetKm == null
      ? Math.abs(a.route!.durationMin + (input.bounds.stopMinutes ?? 0) - input.bounds.targetMinutes) - Math.abs(b.route!.durationMin + (input.bounds.stopMinutes ?? 0) - input.bounds.targetMinutes)
      : Math.abs(a.route!.distanceKm - input.targetKm) - Math.abs(b.route!.distanceKm - input.targetKm))[0];
  if (measured?.route && measured.waypoints?.length) {
    const closestShape = Number(measured.id.slice('candidate-'.length)) - 1;
    const longer = input.bounds.targetMinutes != null && input.bounds.targetKm == null
      ? measured.route.durationMin + (input.bounds.stopMinutes ?? 0) < input.bounds.targetMinutes : measured.route.distanceKm < input.targetKm;
    const adjustable = measured.waypoints.filter(item => item.name !== '目标方向参考点附近');
    const chosen = adjustable.length ? adjustable : measured.waypoints;
    const points = [chosen[0], chosen[chosen.length - 1]];
    await Promise.all(points.map((point, n) => run(3 + n, 1, closestShape, measured,
      longer ? .93 : .75, point.name)));
  } else if (!measured) {
    await Promise.all([3, 4].map(i => run(i, .8)));
  }
  attempts.sort((a, b) => a.id.localeCompare(b.id));
  const accepted = attempts.filter(x => x.status === 'accepted').sort(compareAccepted);
  accepted.forEach((item, i) => { item.rank = i + 1; item.comparison = i === 0 ? (input.overlapMode === 'neutral' ? '满足硬性预算；按目标偏差比较后排名第一，重复率不参与扣分' : '满足硬性预算；按重复率是否可测、估算重复率和目标偏差比较后排名第一') : `满足硬性预算；综合比较排名第 ${i + 1}`; });
  const selectionReason = accepted.length ? (input.overlapMode === 'neutral' ? `在 ${accepted.length} 条符合预算的路线中，按目标距离和时间比较；不因重复道路扣分。` : `在 ${accepted.length} 条符合预算的路线中，优先使用可估算的重复比例，再比较目标距离和时间；未知重复率不代表零重复。`) : '尝试的候选均未满足约束或无法连通。';
  return { selected: accepted[0] || null, attempts, selectionReason };
}
