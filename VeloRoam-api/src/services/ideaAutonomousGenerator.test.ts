import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateAutonomousRoute, proposeWaypoints, validateFixedStops } from './ideaAutonomousGenerator';
import { CompositeRoute, RouteStop } from './ideaRouteService';
import { getDistanceMeters, LatLng } from '../utils/polyline';

const start = { lat: 31.2, lng: 121.4 };
const base = { start, end: start, targetKm: 30, bounds: { minKm: 27, maxKm: 33, targetKm: 30, stopMinutes: 0 } };
const fakeNavigate = async (a: LatLng, b: LatLng) => [{ points: [a, b], distanceKm: Math.max(.01, getDistanceMeters(a, b) / 1000), durationMin: 5, polyline: '' }];
const fakeRoute = (distanceKm: number, durationMin: number): CompositeRoute => ({ legs: [], stops: [], distanceKm, durationMin, hasEstimatedTime: false });
const fakeBuiltRoute = (stops: RouteStop[], km: number, minutes: number): CompositeRoute => ({
  ...fakeRoute(km, minutes), stops: stops.map(stop => ({ type: stop.type, name: stop.name, point: stop.coordinates[0] })),
  legs: stops.filter(stop => stop.type === 'segment').map(stop => ({ type: 'segment' as const, name: stop.name, points: stop.coordinates, distanceKm: 1, durationMin: 3, estimated: true }))
});

test('proposes different coordinates without relying on database points', () => {
  const a = proposeWaypoints(base, 0), b = proposeWaypoints(base, 1);
  assert.equal(a.length, 3);
  assert.ok(getDistanceMeters(start, a[0].coordinates[0]) > 1000);
  assert.ok(getDistanceMeters(a[0].coordinates[0], b[0].coordinates[0]) > 1000);
});

test('keeps generated target-area reference near the focus without requiring the centre', () => {
  const focus = { lat: 31.03, lng: 121.23 };
  const stops = proposeWaypoints({ ...base, focus }, 0);
  const distance = getDistanceMeters(focus, stops[1].coordinates[0]);
  assert.ok(distance > 1000 && distance < 5100);
  const alternative = proposeWaypoints({ ...base, focus }, 2);
  assert.ok(getDistanceMeters(stops[0].coordinates[0], alternative[0].coordinates[0]) > 100);
});

test('compares navigated routes using distance bounds, and retains failures for debugging', async () => {
  let call = 0;
  const result = await generateAutonomousRoute(base, async (_a, _b, _c, _d, stops) => {
    assert.equal(stops.length, 3);
    const i = call++;
    if (i === 1) throw new Error('道路不连通');
    return fakeRoute(i === 0 ? 35 : 29, 90);
  }, fakeNavigate);
  assert.equal(result.attempts.length, 5);
  assert.equal(result.selected?.route?.distanceKm, 29);
  assert.deepEqual(result.attempts.slice(0, 3).map(a => a.status), ['outside_budget', 'unreachable', 'accepted']);
  assert.match(result.attempts[1].reason, /道路不连通/);
});

test('retries a bounded number of alternatives and never accepts an out-of-budget route', async () => {
  const result = await generateAutonomousRoute(base, async () => fakeRoute(40, 120), fakeNavigate);
  assert.equal(result.attempts.length, 5);
  assert.equal(result.selected, null);
  assert.ok(result.attempts.every(a => a.status === 'outside_budget'));
});

test('a time target ranks by time when distance was only estimated', async () => {
  let call = 0;
  const result = await generateAutonomousRoute({ ...base, bounds: { targetMinutes: 120, stopMinutes: 0 } }, async () => {
    const i = call++;
    return fakeRoute(i === 0 ? 30 : 35, i === 0 ? 80 : 118);
  }, fakeNavigate);
  assert.equal(result.selected?.route?.durationMin, 118);
});

test('preserves an explicitly selected segment between generated waypoints', () => {
  const fixed = { type: 'segment' as const, name: '指定路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] };
  const stops = proposeWaypoints({ ...base, fixedSegment: fixed }, 0);
  assert.equal(stops.length, 3);
  assert.equal(stops[1], fixed);
  assert.deepEqual(stops[1].coordinates, fixed.coordinates);
});

test('prefers less repeated navigation geometry among routes within budget', async () => {
  const route = (outAndBack: boolean, distanceKm: number): CompositeRoute => {
    const east = { lat: start.lat, lng: start.lng + .01 };
    const north = { lat: start.lat + .01, lng: start.lng + .01 };
    const west = { lat: start.lat + .01, lng: start.lng };
    return { ...fakeRoute(distanceKm, 100), legs: [{ type: 'connection', name: '道路', points: outAndBack ? [start, east, start] : [start, east, north, west, start], distanceKm, durationMin: 100, estimated: false }] };
  };
  let call = 0;
  const result = await generateAutonomousRoute(base, async () => call++ === 0 ? route(true, 30) : route(false, 32), fakeNavigate);
  assert.equal(result.selected?.route?.distanceKm, 32);
  assert.ok(result.attempts[0].overlap!.fraction > .4);
  assert.ok(result.selected!.overlap!.fraction < .1);
});

test('cannot prefer a low-overlap route outside the budget', async () => {
  let call = 0;
  const result = await generateAutonomousRoute(base, async () => fakeRoute(call++ === 0 ? 30 : 40, 100), fakeNavigate);
  assert.equal(result.selected?.route?.distanceKm, 30);
});

test('retry scales the closest navigated shape instead of switching direction', async () => {
  const fixed = { type: 'segment' as const, name: '指定路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] };
  const starts: Array<{ lat: number; lng: number }> = [];
  let count = 0;
  await generateAutonomousRoute({ ...base, fixedSegment: fixed }, async (_a, _b, _c, _d, stops) => {
    starts.push(stops[0].coordinates[0]);
    const index = count++;
    return fakeBuiltRoute(stops, index === 0 ? 25 : 50, 100);
  }, fakeNavigate);
  assert.equal(starts.length, 5);
  const midLng = (start.lng + fixed.coordinates[0].lng) / 2;
  assert.equal(Math.sign(starts[0].lng - midLng), Math.sign(starts[3].lng - midLng));
  assert.equal(Math.sign(starts[0].lng - midLng), Math.sign(starts[4].lng - midLng));
});

test('uses points along provider trajectories and revalidates connections', async () => {
  let calls = 0;
  const nav = async (a: LatLng, b: LatLng) => {
    calls++;
    const snapped = { lat: b.lat + .0003, lng: b.lng };
    return [{ points: [a, snapped], distanceKm: Math.max(.01, getDistanceMeters(a, snapped) / 1000), durationMin: 5, polyline: '' }];
  };
  const { buildIdeaRoute } = await import('./ideaRouteService');
  const result = await generateAutonomousRoute({ ...base, bounds: {} }, buildIdeaRoute, nav);
  assert.equal(result.attempts.length, 5);
  assert.ok(calls > 21 && calls <= 29);
  for (const attempt of result.attempts.slice(0, 3)) {
    assert.equal(attempt.status, 'accepted');
    assert.equal(attempt.waypoints?.length, 3);
    for (const [index, point] of attempt.waypoints!.entries()) {
      assert.equal(point.source, 'bicycling_route');
      assert.ok(point.samples.length >= 3);
      assert.deepEqual(point.selected, point.samples.find(sample => sample.status === 'selected')?.point);
      assert.equal(point.samples.find(sample => sample.status === 'selected')?.fraction, .85);
      assert.deepEqual(attempt.stops[index].coordinates[0], point.selected);
    }
  }
});

test('rejects road suggestions when navigation does not reach the proposed location', async () => {
  let built = 0;
  const result = await generateAutonomousRoute(base, async () => { built++; return fakeRoute(30, 100); }, async (a: LatLng) => [{ points: [a, { lat: a.lat + .001, lng: a.lng }], distanceKm: 1, durationMin: 5, polyline: '' }]);
  assert.equal(result.selected, null);
  assert.equal(built, 0);
  assert.ok(result.attempts.every(item => item.status === 'unreachable' && /无法吸附/.test(item.reason)));
});

test('keeps segment orientation while connecting it to provider-derived waypoints', async () => {
  const fixed = { type: 'segment' as const, name: '指定路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] };
  const { buildIdeaRoute } = await import('./ideaRouteService');
  const result = await generateAutonomousRoute({ ...base, bounds: {}, fixedSegment: fixed }, buildIdeaRoute, fakeNavigate);
  const selected = result.selected!;
  assert.ok(selected);
  assert.equal(selected.waypoints?.length, 2);
  assert.equal(selected.stops[1], fixed);
  const segmentLeg = selected.route!.legs.find(leg => leg.type === 'segment');
  assert.deepEqual(segmentLeg?.points, fixed.coordinates);
});

test('when too short, retries use farther samples from the previous navigation trajectories', async () => {
  let call = 0;
  const result = await generateAutonomousRoute(base, async () => fakeRoute(call++ < 3 ? 20 : 30, 100), fakeNavigate);
  assert.equal(result.attempts.length, 5);
  assert.equal(result.attempts[0].waypoints?.[0].samples.find(x => x.status === 'selected')?.fraction, .85);
  assert.equal(result.attempts[3].waypoints?.[0].samples.find(x => x.status === 'selected')?.fraction, .93);
  assert.equal(result.attempts[4].waypoints?.[0].samples.find(x => x.status === 'selected')?.fraction, .85);
  assert.equal(result.attempts[4].waypoints?.[2].samples.find(x => x.status === 'selected')?.fraction, .93);
  assert.deepEqual(result.attempts[3].waypoints?.[0].seedPath, result.attempts[0].waypoints?.[0].seedPath);
});

test('refines one waypoint per combination while preserving the fixed segment', async () => {
  const fixed = { type: 'segment' as const, name: '固定路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] };
  const result = await generateAutonomousRoute({ ...base, fixedSegment: fixed }, async (_a, _b, _c, _d, stops) => fakeBuiltRoute(stops, 29, 90), fakeNavigate);
  assert.equal(result.attempts.length, 5);
  for (const attempt of result.attempts.slice(3)) {
    assert.equal(attempt.status, 'accepted');
    assert.ok(attempt.change);
    const baseline = result.attempts.find(item => item.id === attempt.change!.baselineId)!;
    assert.equal(attempt.stops[1], fixed);
    const changed = attempt.waypoints!.filter((point, i) => getDistanceMeters(point.selected, baseline.waypoints![i].selected) > 1);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].name, attempt.change!.waypoint);
  }
  assert.equal(result.selected?.rank, 1);
  assert.match(result.selectionReason!, /未知/);
});

test('keeps a valid baseline when every refinement exceeds the hard budget', async () => {
  let count = 0;
  const result = await generateAutonomousRoute(base, async () => fakeRoute(count++ < 3 ? 30 : 36, 100), fakeNavigate);
  assert.equal(result.selected?.route?.distanceKm, 30);
  assert.ok(result.attempts.slice(3).every(item => item.status === 'outside_budget'));
  assert.ok(result.attempts.slice(0, 3).every(item => item.status === 'accepted'));
});

test('individual refinements preserve the target direction waypoint', async () => {
  const focus = { lat: 31.03, lng: 121.23 };
  const result = await generateAutonomousRoute({ ...base, focus }, async () => fakeRoute(29, 100), fakeNavigate);
  for (const item of result.attempts.slice(3)) {
    assert.equal(item.status, 'accepted');
    assert.notEqual(item.change?.waypoint, '目标方向参考点附近');
    const initial = result.attempts.find(x => x.id === item.change!.baselineId)!;
    const focusBefore = initial.waypoints!.find(x => x.name === '目标方向参考点附近')!;
    const focusAfter = item.waypoints!.find(x => x.name === '目标方向参考点附近')!;
    assert.deepEqual(focusAfter.selected, focusBefore.selected);
    assert.ok(focusAfter.offsetMeters <= 300);
  }
});

test('a candidate must meet both distance and time limits before ranking', async () => {
  let count = 0;
  const result = await generateAutonomousRoute({ ...base, bounds: { ...base.bounds, maxMinutes: 120 } }, async () => {
    const i = count++;
    return fakeRoute(i === 0 ? 30 : 31, i === 0 ? 150 : 110);
  }, fakeNavigate);
  assert.equal(result.attempts[0].status, 'outside_budget');
  assert.match(result.attempts[0].reason, /时间上限/);
  assert.equal(result.selected?.route?.durationMin, 110);
});

test('does not penalize repetition when the rider explicitly wants an out-and-back', async () => {
  const east = { lat: start.lat, lng: start.lng + .01 };
  const north = { lat: start.lat + .01, lng: start.lng + .01 };
  const west = { lat: start.lat + .01, lng: start.lng };
  const make = (repeat: boolean, distanceKm: number): CompositeRoute => ({ ...fakeRoute(distanceKm, 100), legs: [{ type: 'connection', name: '道路', points: repeat ? [start, east, start] : [start, east, north, west, start], distanceKm, durationMin: 100, estimated: false }] });
  let count = 0;
  const result = await generateAutonomousRoute({ ...base, overlapMode: 'neutral' }, async () => count++ === 0 ? make(true, 30) : make(false, 32), fakeNavigate);
  assert.equal(result.selected?.route?.distanceKm, 30);
  assert.match(result.selectionReason!, /不因重复道路扣分/);
});

test('keeps multiple fixed stops in order while generating surrounding points', async () => {
  const fixedSegment = { type: 'segment' as const, name: '固定路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] };
  const fixedPoint = { type: 'point' as const, name: '咖啡店', coordinates: [{ lat: 31.23, lng: 121.43 }] };
  const { buildIdeaRoute } = await import('./ideaRouteService');
  for (const fixedStops of [[fixedSegment, fixedPoint], [fixedPoint, fixedSegment]]) {
    const result = await generateAutonomousRoute({ ...base, bounds: {}, fixedStops }, buildIdeaRoute, fakeNavigate);
    assert.ok(result.selected);
    const selected = result.selected!;
    assert.equal(selected.stops[1], fixedStops[0]);
    assert.equal(selected.stops[2], fixedStops[1]);
    assert.deepEqual(selected.route!.stops.slice(2, 4).map(stop => stop.name), fixedStops.map(stop => stop.name));
    assert.deepEqual(selected.route!.legs.find(leg => leg.type === 'segment')!.points, fixedSegment.coordinates);
  }
});

test('rejects missing, reordered, and reversed fixed stops', () => {
  const segment = { type: 'segment' as const, name: '路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] };
  const cafe = { type: 'point' as const, name: '咖啡', coordinates: [{ lat: 31.23, lng: 121.43 }] };
  assert.equal(validateFixedStops(fakeBuiltRoute([segment, cafe], 30, 100), [segment, cafe]), null);
  assert.match(validateFixedStops(fakeBuiltRoute([cafe, segment], 30, 100), [segment, cafe])!, /顺序/);
  assert.match(validateFixedStops(fakeBuiltRoute([segment], 30, 100), [segment, cafe])!, /咖啡/);
  const route = fakeBuiltRoute([segment, cafe], 30, 100);
  route.legs[0].points = [...segment.coordinates].reverse();
  assert.match(validateFixedStops(route, [segment, cafe])!, /轨迹或方向/);
});

test('does not accept a candidate that silently drops required stops even if its budget matches', async () => {
  const segment = { type: 'segment' as const, name: '路段', coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }] };
  const result = await generateAutonomousRoute({ ...base, fixedStops: [segment] }, async () => fakeRoute(30, 90), fakeNavigate);
  assert.equal(result.selected, null);
  assert.ok(result.attempts.every(item => item.status === 'unreachable' && /途经顺序/.test(item.reason)));
});
