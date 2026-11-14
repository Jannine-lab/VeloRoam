import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Request, Response } from 'express';
import { Candidate, createIdeaController, planFromIntent } from './ideaController';
import { ConversationIntent, sanitizeConversationIntent } from '../services/ideaIntent';
import { unknownRouteTags } from '../services/ideaTagPreferences';
import { CompositeRoute, RouteStop } from '../services/ideaRouteService';
import { AIMessage } from '@langchain/core/messages';

const origin = { lat: 31.2, lng: 121.4 };
const intent = (fields: Record<string, unknown>): ConversationIntent => sanitizeConversationIntent({ mode: 'route', ...fields })!;
const segment = (id: string, popular: 'matched' | 'not_matched' | 'unknown'): Candidate => ({
  id: `segment:${id}`, type: 'segment', name: `路段${id}`, lat: 31.21, lng: 121.41,
  coordinates: [{ lat: 31.21, lng: 121.41 }, { lat: 31.22, lng: 121.42 }], hazardous: false,
  tags: { ...unknownRouteTags(), popular }
});
const fakeRoute = (distanceKm: number, durationMin: number): CompositeRoute => ({ legs: [], stops: [], distanceKm, durationMin, hasEstimatedTime: true });

test('native tools feed real grounding and reuse request reads while returning trace metadata', async () => {
  let reads = 0; let turns = 0;
  const candidate = segment('101', 'matched');
  const controller = createIdeaController({ isConfigured: () => true,
    search: async () => { reads++; return [candidate]; }, resolve: async () => null, near: async () => [],
    toolCaller: async () => !turns++ ? new AIMessage({ content: '', tool_calls: [{ name: 'search_candidates', args: { name: '路段101', terms: [] }, id: 'call1' }] })
      : new AIMessage('{"mode":"answer","reply":"忽略这段无依据的文字","lookup":{"name":"路段101","terms":[],"kind":"segment"}}') });
  const result = await invoke(controller, { idea: '介绍一下路段101', center: origin });
  assert.equal(result.body.items[0].id, candidate.id); assert.equal(reads, 1);
  assert.equal(result.body.meta.modelCalls, 2); assert.equal(result.body.meta.toolCalls[0].name, 'search_candidates');
  assert.doesNotMatch(result.body.message, /无依据/);
});

async function invokeRaw(controller: ReturnType<typeof createIdeaController>, body: object): Promise<{ status: number; body: any }> {
  let code = 200; let payload: any;
  const req = { body, get: () => '' } as unknown as Request;
  const res = { status(value: number) { code = value; return this; }, json(value: any) { payload = value; return value; } } as unknown as Response;
  await controller(req, res);
  return { status: code, body: payload };
}

async function invoke(controller: ReturnType<typeof createIdeaController>, body: any): Promise<{ status: number; body: any }> {
  const first = await invokeRaw(controller, body);
  if (!first.body.contextIntent?.confirmationPending) return first;
  return invokeRaw(controller, { ...body, idea: '确认，开始规划', previousIntent: first.body.contextIntent, placeContext: first.body.placeContext });
}

test('confirmation preserves the shown intent; edits require a fresh confirmation', async () => {
  let planned: ConversationIntent | null = null;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async (_system, input: any) => ({ mode: 'route', targetKm: input.idea.includes('40') ? 40 : 30, preferences: ['轻松'] }),
    plan: async value => { planned = value; return { message: '已规划' }; } });
  const first = await invokeRaw(controller, { idea: '轻松骑30公里', center: origin, origin });
  assert.match(first.body.message, /全程目标约 30 公里/);
  assert.equal(planned, null);
  const edited = await invokeRaw(controller, { idea: '改成40公里', center: origin, origin, previousIntent: first.body.contextIntent });
  assert.match(edited.body.message, /全程目标约 40 公里/);
  assert.equal(planned, null);
  const result = await invokeRaw(controller, { idea: '确认，开始规划', center: origin, origin, previousIntent: edited.body.contextIntent });
  assert.equal(result.body.message, '已规划');
  assert.equal((planned as ConversationIntent | null)?.targetKm, 40);
});

test('a clarification about distance scope does not start planning', async () => {
  let planned = false;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'scope', reply: '50公里是全程还是到达后骑行？' }),
    plan: async () => { planned = true; return {}; } });
  const result = await invokeRaw(controller, { idea: '到那里再骑50公里', center: origin, origin });
  assert.match(result.body.message, /全程还是/);
  assert.equal(planned, false);
});

test('plans without optional budget or experience and preserves later user constraints', async () => {
  const answers = [
    { mode: 'clarify', requestType: 'route', clarificationKind: 'budget_and_preference', preferences: [] },
    { mode: 'clarify', requestType: 'route', clarificationKind: 'preference', targetKm: 50, preferences: [] },
    { mode: 'route', requestType: 'route', targetKm: 50, preferences: ['轻松'], returnToStart: false }
  ];
  const seen: any[] = []; let planned: ConversationIntent | null = null;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async (_system, input) => { seen.push(input); return answers.shift(); },
    plan: async value => { planned = value; return { message: '已规划', items: [] }; } });
  const first = await invoke(controller, { idea: '我想骑车', center: origin, origin });
  assert.equal(first.body.message, '已规划');
  assert.equal((planned as ConversationIntent | null)?.targetKm, null);
  assert.deepEqual((planned as ConversationIntent | null)?.preferences, []);
  const second = await invoke(controller, { idea: '50公里', center: origin, origin, previousIntent: first.body.contextIntent });
  assert.equal(second.body.message, '已规划');
  assert.equal(second.body.contextIntent.targetKm, 50);
  const third = await invoke(controller, { idea: '轻松', center: origin, origin, previousIntent: second.body.contextIntent });
  assert.equal(third.body.message, '已规划');
  assert.equal((seen[2] as any).previousIntent.targetKm, 50);
  assert.equal((planned as ConversationIntent | null)?.returnToStart, false);
});

test('a model destination clarification does not override the default destination', async () => {
  let planCalled = false;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'destination', targetKm: 40, preferences: ['轻松'] }),
    plan: async () => { planCalled = true; return { message: '已规划', items: [] }; } });
  const response = await invoke(controller, { idea: '轻松骑40公里', center: origin, origin });
  assert.equal(response.body.message, '已规划');
  assert.equal(planCalled, true);
});

test('a model does not repeat preference questions when both requirements are known', async () => {
  let planCalled = false;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'preference', targetKm: 40, preferences: ['轻松'] }),
    plan: async () => { planCalled = true; return { message: '已规划', items: [] }; } });
  const response = await invoke(controller, { idea: '轻松骑40公里', center: origin, origin });
  assert.equal(response.body.message, '已规划');
  assert.equal(planCalled, true);
});

test('a generic model clarification does not repeat known route requirements', async () => {
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'purpose', minKm: 40, maxKm: 60, targetKm: 50, preferences: ['轻松'] }),
    plan: async () => ({ message: '已规划', items: [] }) });
  const response = await invoke(controller, { idea: '轻松骑50公里，范围40到60公里', center: origin, origin });
  assert.equal(response.body.message, '已规划');
  assert.equal(response.body.contextIntent.targetKm, 50);
  assert.equal(response.body.contextIntent.minKm, 40);
  assert.equal(response.body.contextIntent.maxKm, 60);
});

test('asks when the order of requested stops is genuinely unclear', async () => {
  let planned = false;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'order', reply: '想先骑路段还是先去咖啡店？' }),
    plan: async () => { planned = true; return {}; } });
  const response = await invoke(controller, { idea: '骑路段和去咖啡店', center: origin, origin });
  assert.match(response.body.message, /先骑路段/);
  assert.equal(planned, false);
});

test('plans a requested area without a budget but does not ignore an explicit incompatible distance', async () => {
  const candidate = segment('1', 'unknown');
  const overrides = {
    resolve: async () => ({ lat: 31.03, lng: 121.23 }),
    generate: async () => ({ selected: null, attempts: [] }),
    near: async () => [candidate],
    model: async () => ({ ids: [candidate.id] }),
    build: async () => fakeRoute(80, 240)
  };
  const result: any = await planFromIntent(intent({ place: '松江' }), '想去松江骑', origin, 'gps', () => {}, overrides);
  assert.equal(result.route.distanceKm, 80);
  const constrained: any = await planFromIntent(intent({ place: '松江', targetKm: 20 }), '想去松江骑20公里', origin, 'gps', () => {}, overrides);
  assert.equal(constrained.route, undefined);
  assert.match(constrained.message, /实际里程或时间不符合要求/);
  assert.ok(constrained.options.length);
});

test('automatically returns to current location, applies 10% bounds and uses tags', async () => {
  const candidates = [segment('1', 'matched'), segment('2', 'unknown'), segment('3', 'not_matched')];
  const buildCalls: Array<{ start: typeof origin; end: typeof origin }> = [];
  const result: any = await planFromIntent(intent({ targetKm: 50, preferences: ['热门'], preferredTags: ['popular'] }), '热门50公里', origin, 'gps', () => {}, {
    generate: async () => ({ selected: null, attempts: [] }),
    near: async () => candidates,
    model: async () => ({ ids: ['segment:2', 'segment:1', 'segment:3'] }),
    build: async (start, _startName, end, _endName, stops) => {
      buildCalls.push({ start, end });
      return fakeRoute(stops[0].name === '路段1' ? 55 : stops[0].name === '路段2' ? 50 : 56, 160);
    }
  });
  assert.equal(result.route.distanceKm, 55);
  assert.match(result.message, /路段1/);
  assert.match(result.distanceNote, /10%/);
  assert.ok(buildCalls.every(call => call.start === origin && call.end === origin));
});

test('time target selects a closer estimated ride among equally matched candidates', async () => {
  const result: any = await planFromIntent(intent({ targetMinutes: 120, preferences: ['轻松'] }), '轻松骑两小时', origin, 'gps', () => {}, {
    generate: async () => ({ selected: null, attempts: [] }),
    near: async () => [segment('1', 'unknown'), segment('2', 'unknown')],
    model: async () => ({ ids: ['segment:1', 'segment:2'] }),
    build: async (_a, _b, _c, _d, stops: RouteStop[]) => fakeRoute(30, stops[0].name === '路段1' ? 80 : 118)
  });
  assert.match(result.message, /路段2/);
  assert.match(result.distanceNote, /目标约 120 分钟/);
});

test('a named origin with no stated end uses the current location; explicit return uses origin', async () => {
  const namedOrigin = { lat: 31.25, lng: 121.45 };
  let routeEnd: typeof origin | null = null;
  const result: any = await planFromIntent(intent({ origin: '指定出发地', targetKm: 40, preferences: ['轻松'] }), '从指定出发地骑40公里', origin, 'gps', () => {}, {
    resolve: async () => namedOrigin,
    build: async (_start, _name, end) => { routeEnd = end; return fakeRoute(40, 120); }
  });
  assert.equal(result.message, '已生成完整骑行路线');
  assert.equal(routeEnd, origin);
  const missing: any = await planFromIntent(intent({ origin: '指定出发地', targetKm: 40, preferences: ['轻松'] }), '从指定出发地骑40公里', null, 'gps', () => {}, { resolve: async () => namedOrigin });
  assert.equal(missing.needsOrigin, true);
  let returnEnd: typeof origin | null = null;
  await planFromIntent(intent({ origin: '指定出发地', returnToStart: true, targetKm: 40, preferences: ['轻松'] }), '返回出发地', null, 'gps', () => {}, {
    resolve: async () => namedOrigin, generate: async () => ({ selected: null, attempts: [] }), near: async () => [segment('1', 'unknown')], model: async () => ({ ids: ['segment:1'] }),
    build: async (_start, _name, end) => { returnEnd = end; return fakeRoute(40, 120); }
  });
  assert.equal(returnEnd, namedOrigin);
});

test('unknown stop duration is disclosed when a time limit includes stops', async () => {
  const result: any = await planFromIntent(intent({ maxMinutes: 120, timeScope: 'total', preferences: ['轻松'] }), '两小时内回来', origin, 'gps', () => {}, {
    generate: async () => ({ selected: null, attempts: [] }),
    near: async () => [segment('1', 'unknown')], model: async () => ({ ids: ['segment:1'] }), build: async () => fakeRoute(20, 90)
  });
  assert.match(result.note, /停留时长未知/);
});

test('known stops are included in total time and explicit avoidances are qualified', async () => {
  const result: any = await planFromIntent(intent({ maxMinutes: 120, timeScope: 'total', stopMinutes: 20,
    preferences: ['轻松', '不要爬坡'], avoidTags: ['climbing'] }), '两小时内回来，不要爬坡', origin, 'gps', () => {}, {
    generate: async () => ({ selected: null, attempts: [] }),
    near: async () => [segment('1', 'unknown')], model: async () => ({ ids: ['segment:1'] }), build: async () => fakeRoute(20, 90)
  });
  assert.match(result.distanceNote, /骑行 90 分钟、停留 20 分钟，总计约 110 分钟/);
  assert.match(result.note, /连接道路未能完整验证/);
});

test('grounded place dialogue remembers a selected candidate and plans with its fresh identity', async () => {
  const candidate = segment('99', 'matched');
  const answers = [
    { mode: 'answer', reply: '不应直接返回模型编造的描述', lookup: { name: '示例滨水区', terms: [], kind: 'ambiguous' } },
    { mode: 'clarify', requestType: 'route', clarificationKind: 'budget_and_preference', preferences: [] },
    { mode: 'route', requestType: 'route', targetKm: 30, preferences: ['轻松'], selectedCandidateId: candidate.id }
  ];
  let plannedId = '';
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => answers.shift(), search: async () => [candidate], resolve: async () => null, near: async () => [],
    plan: async (_intent, _idea, _origin, _source, _progress, overrides) => {
      plannedId = (await overrides!.named!(origin, candidate.name))[0].id;
      return { message: '已规划', items: [] };
    } });
  const first = await invoke(controller, { idea: '示例滨水区骑行怎么样', center: origin, origin });
  assert.doesNotMatch(first.body.message, /模型编造/);
  assert.equal(first.body.items[0].id, candidate.id);
  const second = await invoke(controller, { idea: '规划路线', center: origin, origin, placeContext: first.body.placeContext });
  assert.match(second.body.message, /无法确定/);
  assert.ok(second.body.options.some((option: string) => option.includes(candidate.name)));
  const third = await invoke(controller, { idea: '选第一个，轻松骑30公里', center: origin, origin, previousIntent: second.body.contextIntent, placeContext: second.body.placeContext });
  assert.equal(third.body.message, '已规划');
  assert.equal(plannedId, candidate.id);
});

test('an area is not forced to match a segment with the same name', async () => {
  let planned: ConversationIntent | null = null;
  const candidate = segment('88', 'unknown');
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'route', requestType: 'route', targetKm: 30, preferences: ['轻松'], place: '示例区域', needsSegment: true, segmentName: '示例区域', stops: [{ type: 'segment', name: '示例区域' }] }),
    search: async () => [], resolve: async () => origin, near: async () => [candidate],
    plan: async value => { planned = value; return { message: '已规划', items: [] }; } });
  const result = await invoke(controller, { idea: '轻松骑30公里', center: origin, origin,
    placeContext: { query: '示例区域', area: '示例区域', candidates: [{ id: candidate.id, type: candidate.type, name: candidate.name }], selectedId: null } });
  assert.equal(result.body.message, '已规划');
  assert.equal((planned as ConversationIntent | null)?.place, '示例区域');
  assert.equal((planned as ConversationIntent | null)?.needsSegment, false);
  assert.deepEqual((planned as ConversationIntent | null)?.stops, []);
});

test('a fabricated or stale candidate id cannot be used for planning', async () => {
  const candidate = segment('77', 'unknown');
  let planned = false;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'route', requestType: 'route', targetKm: 30, preferences: ['轻松'], needsSegment: true, segmentName: '示例地点', selectedCandidateId: 'segment:999' }),
    search: async () => [candidate], resolve: async () => null, near: async () => [], plan: async () => { planned = true; return {}; } });
  const result = await invoke(controller, { idea: '选第一个', center: origin, origin,
    placeContext: { query: '示例地点', candidates: [{ id: 'segment:999', type: 'segment', name: '不存在' }], selectedId: null } });
  assert.equal(planned, false);
  assert.match(result.body.message, /无法确定/);
});

test('does not lose an unresolved place when the model omits it on a later route turn', async () => {
  let called = false;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'route', requestType: 'route', targetKm: 30, preferences: ['轻松'] }),
    search: async () => [segment('123', 'unknown')], resolve: async () => null, near: async () => [],
    plan: async () => { called = true; return {}; } });
  const result = await invoke(controller, { idea: '轻松骑30公里', center: origin, origin,
    placeContext: { query: '尚未确认的滨水区', candidates: [{ id: 'segment:123', type: 'segment', name: '候选路段' }], selectedId: null } });
  assert.equal(called, false);
  assert.match(result.body.message, /无法确定/);
  assert.equal(result.body.contextIntent.targetKm, 30);
});

test('an explicitly new conversation clears the previous focus', async () => {
  let called = false;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'route', requestType: 'route', newConversation: true, targetKm: 30, preferences: ['轻松'] }),
    plan: async () => { called = true; return { message: '已规划', items: [] }; } });
  const result = await invoke(controller, { idea: '重新规划一条轻松骑30公里', center: origin, origin,
    placeContext: { query: '旧地点', candidates: [], selectedId: null } });
  assert.equal(called, true);
  assert.equal(result.body.placeContext, null);
});

test('autonomous loop does not require saved POIs and keeps the selected navigation route', async () => {
  const route = fakeRoute(31, 100);
  let generated = false;
  const result: any = await planFromIntent(intent({ targetKm: 30, preferences: ['轻松'] }), '轻松骑30公里', origin, 'gps', () => {}, {
    near: async () => { throw new Error('不应依赖点位数据库'); },
    generate: async input => {
      generated = true;
      assert.equal(input.bounds.minKm, 27);
      assert.equal(input.bounds.maxKm, 33);
      assert.deepEqual(input.start, input.end);
      return { selected: { id: 'candidate-1', stops: [], route, status: 'accepted', reason: '满足预算' }, attempts: [] };
    }
  });
  assert.equal(generated, true);
  assert.equal(result.route, route);
  assert.match(result.distanceNote, /10%/);
});

test('combines an explicitly requested segment with generated waypoints', async () => {
  const candidate = segment('76', 'matched');
  const route = fakeRoute(30, 100);
  let fixedId = '';
  const result: any = await planFromIntent(intent({ targetKm: 30, preferences: ['轻松'], needsSegment: true, segmentName: candidate.name }), '经过指定路段骑30公里', origin, 'gps', () => {}, {
    resolve: async () => origin, named: async () => [candidate], model: async () => ({ ids: [candidate.id] }),
    generate: async input => {
      fixedId = input.fixedSegment?.detail?.id || '';
      return { selected: { id: 'candidate-1', stops: [input.fixedSegment!], route, status: 'accepted', reason: '满足预算' }, attempts: [] };
    },
    build: async () => { throw new Error('不应使用旧的单点路线'); }
  });
  assert.equal(fixedId, candidate.id);
  assert.equal(result.route, route);
  assert.match(result.message, /自主途经点/);
});

test('does not present an unverified route as an exact original-road return', async () => {
  let generated = false;
  const result: any = await planFromIntent(intent({ targetKm: 30, preferences: ['轻松', '原路返回'] }), '骑30公里，原路返回', origin, 'gps', () => {}, {
    generate: async () => { generated = true; return { selected: null, attempts: [] }; }
  });
  assert.equal(generated, false);
  assert.match(result.message, /无法验证返程/);
});

test('accepts a later explicit relaxation of original-road return', async () => {
  const route = fakeRoute(30, 100);
  const result: any = await planFromIntent(intent({ targetKm: 30, preferences: ['轻松'] }), '原路返回\n允许返程走其他骑行道路', origin, 'gps', () => {}, {
    generate: async () => ({ selected: { id: 'ok', stops: [], route, status: 'accepted', reason: '满足预算' }, attempts: [] })
  });
  assert.equal(result.route, route);
});

test('passes ordered segment and cafe to the autonomous generator without dropping either', async () => {
  const candidate = segment('76', 'matched');
  const cafe = { lat: 31.23, lng: 121.43 };
  const route = fakeRoute(50, 140);
  let names: string[] = [];
  const result: any = await planFromIntent(intent({ targetKm: 50, preferences: ['轻松'], stops: [{ type: 'segment', name: candidate.name }, { type: 'point', name: '咖啡店' }] }), '先路段再咖啡', origin, 'gps', () => {}, {
    resolve: async name => name === '咖啡店' ? cafe : origin,
    named: async () => [candidate], model: async () => ({ ids: [candidate.id] }),
    generate: async input => { names = (input.fixedStops || []).map(stop => stop.name); return { selected: { id: 'ok', stops: input.fixedStops!, route, status: 'accepted', reason: '满足预算' }, attempts: [] }; }
  });
  assert.deepEqual(names, [candidate.name, '咖啡店']);
  assert.equal(result.route, route);
});

test('selecting a segment preserves the other requested stops', async () => {
  const candidate = segment('76', 'matched');
  let planned: ConversationIntent | null = null;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'route', requestType: 'route', targetKm: 50, preferences: ['轻松'], selectedCandidateId: candidate.id, needsSegment: true, needsPoint: true, stops: [{ type: 'segment', name: candidate.name }, { type: 'point', name: '咖啡店' }] }),
    search: async () => [candidate], resolve: async () => null, near: async () => [],
    plan: async value => { planned = value; return { message: '已规划', items: [] }; } });
  const result = await invoke(controller, { idea: '选择路段并去咖啡店', center: origin, origin,
    placeContext: { query: candidate.name, candidates: [{ id: candidate.id, type: candidate.type, name: candidate.name }], selectedId: null } });
  assert.equal(result.body.message, '已规划');
  assert.deepEqual((planned as ConversationIntent | null)?.stops.map(stop => stop.name), [candidate.name, '咖啡店']);
});

test('discloses that a named-road avoidance cannot be verified on connection roads', async () => {
  const result: any = await planFromIntent(intent({ origin: '起点', destination: '终点', targetKm: 30, preferences: ['避开示例道路'] }), '避开示例道路', origin, 'gps', () => {}, {
    resolve: async name => name === '起点' ? origin : { lat: 31.25, lng: 121.45 }, build: async () => fakeRoute(30, 100)
  });
  assert.match(result.note, /避开条件尚未对全部连接道路验证/);
});

test('discloses when an area and fixed stops have not been jointly verified', async () => {
  const route = fakeRoute(30, 100);
  const result: any = await planFromIntent(intent({ place: '示例区域', targetKm: 30, preferences: ['轻松'], stops: [{ type: 'point', name: '咖啡店' }] }), '去示例区域经过咖啡店', origin, 'gps', () => {}, {
    resolve: async () => ({ lat: 31.21, lng: 121.41 }),
    generate: async input => ({ selected: { id: 'ok', stops: input.fixedStops!, route, status: 'accepted', reason: '满足预算' }, attempts: [] })
  });
  assert.equal(result.route, route);
  assert.match(result.note, /尚未验证指定区域/);
});

test('plans a confirmed segment with a bounded enroute discovery and explains the added road', async () => {
  const makePoint = (lng: number) => ({ lat: 31.2, lng });
  const start = makePoint(121.4);
  const fixedCandidate: Candidate = { id: 'segment:76', type: 'segment', name: '沿江路段', lat: 31.2, lng: 121.43,
    coordinates: [makePoint(121.43), makePoint(121.432), makePoint(121.434)], score: 80 };
  const extra: Candidate = { id: 'segment:77', type: 'segment', name: '顺路绿道', lat: 31.2, lng: 121.408,
    coordinates: [makePoint(121.408), makePoint(121.41), makePoint(121.412)], score: 90 };
  const { buildIdeaRoute } = await import('../services/ideaRouteService');
  const { getDistanceMeters } = await import('../utils/polyline');
  const navigate: any = async (a: any, b: any) => [{ points: [a, b], distanceKm: getDistanceMeters(a, b) / 1000, durationMin: getDistanceMeters(a, b) / 300 }];
  const build: typeof buildIdeaRoute = (a, an, b, bn, stops) => buildIdeaRoute(a, an, b, bn, stops, navigate);
  const result: any = await planFromIntent(intent({ targetKm: 7, needsSegment: true, segmentName: fixedCandidate.name }), '经过沿江路段骑7公里', start, 'gps', () => {}, {
    resolve: async () => start, named: async () => [fixedCandidate], near: async () => [extra], model: async () => ({ ids: [fixedCandidate.id] }), build,
    generate: async input => ({ selected: { id: 'baseline', stops: input.fixedStops!, route: await build(start, '起点', start, '返回起点', input.fixedStops!), status: 'accepted', reason: '满足预算' }, attempts: [] })
  });
  assert.deepEqual(result.route.legs.filter((leg: any) => leg.type === 'segment').map((leg: any) => leg.name), ['顺路绿道', '沿江路段']);
  assert.match(result.note, /加入顺路路段：.*顺路绿道/);
  assert.match(result.note, /与未加入时相比/);
});

test('expands related search on request, deduplicates and lets the user select a fresh ID', async () => {
  const prior = segment('101', 'matched');
  const related = { ...segment('102', 'matched'), name: 'jiang River 绿道', lat: 31.21, lng: 121.4 };
  let plannedId = ''; let receivedTerms: string[] = []; let lookups = 0;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async (system) => system.includes('生成关联关键词') ? { terms: ['江', 'yanjiang', 'jiang', 'river', '%'] } :
      { mode: 'route', requestType: 'route', targetKm: 30, selectedCandidateId: related.id, needsSegment: true, segmentName: related.name },
    search: async () => [], resolve: async () => null, near: async () => [],
    related: async (_center, terms) => { receivedTerms = terms; return [prior, related, related]; },
    byId: async id => { lookups++; return id === related.id ? related : null; },
    plan: async (_intent, _idea, _origin, _source, _progress, overrides) => {
      plannedId = (await overrides!.named!(origin, related.name))[0].id;
      return { message: '已规划', items: [] };
    }
  });
  const expanded = await invokeRaw(controller, { idea: '查看更多相关路段和地点', center: origin, origin,
    previousIntent: intent({ targetKm: 30 }), placeContext: { query: '沿江', candidates: [{ id: prior.id, type: prior.type, name: prior.name }] },
    moreSearch: { query: '沿江', idea: '想沿江骑行', center: origin } });
  assert.equal(expanded.status, 200);
  assert.deepEqual(receivedTerms, ['沿江', '江', 'yanjiang', 'jiang', 'river']);
  assert.deepEqual(expanded.body.items.map((item: Candidate) => item.id), [related.id]);
  assert.match(expanded.body.items[0].reason, /jiang/i);
  assert.match(expanded.body.message, /50 公里/);
  assert.equal(expanded.body.placeContext.candidates[0].id, related.id);
  assert.equal(expanded.body.contextIntent.targetKm, 30);
  const selected = await invoke(controller, { idea: '选择第一个', center: origin, origin, previousIntent: expanded.body.contextIntent, placeContext: expanded.body.placeContext });
  assert.equal(selected.body.message, '已规划');
  assert.equal(plannedId, related.id);
  assert.ok(lookups > 0);
});

test('reports related-search failures rather than presenting them as empty results', async () => {
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ terms: ['江'] }), related: async () => { throw Error('database unavailable'); } });
  const result = await invokeRaw(controller, { idea: '更多', center: origin, moreSearch: { query: '沿江', idea: '沿江骑行', center: origin } });
  assert.equal(result.status, 502);
  assert.ok(result.body.error);
});

test('the confirmed route agent calls the planner once and returns the authoritative route', async () => {
  let modelTurns = 0; let plans = 0; let seenTarget: number | null = null;
  const route = fakeRoute(30, 90);
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [], resolve: async () => null, near: async () => [],
    toolCaller: async messages => {
      modelTurns++;
      if (modelTurns === 1) return new AIMessage('{"mode":"route","requestType":"route","targetKm":30,"preferences":["轻松"]}');
      if (modelTurns === 2) return new AIMessage({ content: '', tool_calls: [
        { name: 'plan_cycling_route', args: {}, id: 'route-1' }, { name: 'plan_cycling_route', args: {}, id: 'route-2' }
      ] });
      assert.match(String(messages.at(-1)?.content), /planned/);
      return new AIMessage('{"mode":"route","targetKm":500}');
    },
    plan: async value => { plans++; seenTarget = value.targetKm; return { message: '已规划', items: [], route }; }
  });
  const first = await invokeRaw(controller, { idea: '轻松骑30公里', center: origin, origin });
  assert.equal(plans, 0); assert.equal(first.body.contextIntent.confirmationPending, true);
  const next = await invokeRaw(controller, { idea: '确认，开始规划', center: origin, origin, previousIntent: first.body.contextIntent });
  assert.equal(next.body.route.distanceKm, 30); assert.equal(next.body.contextIntent.targetKm, 30);
  assert.equal(seenTarget, 30); assert.equal(plans, 1);
  assert.deepEqual(next.body.meta.toolCalls.map((call: any) => call.name), ['plan_cycling_route', 'plan_cycling_route']);
});

test('confirmed agent returns the baseline and explored alternative without changing the confirmed budget', async () => {
  let turns = 0, plans = 0, explores = 0;
  const base = fakeRoute(30, 90), optimized = fakeRoute(31, 95);
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [], resolve: async () => null, near: async () => [],
    toolCaller: async messages => {
      if (!turns++) return new AIMessage('{"mode":"route","targetKm":30,"needsSegment":true}');
      if (turns === 2) return new AIMessage({ content: '', tool_calls: [
        { name: 'plan_cycling_route', args: {}, id: 'plan' }, { name: 'find_enroute_segments', args: {}, id: 'explore' }
      ] });
      assert.match(String(messages.at(-1)!.content), /顺路绿道/);
      return new AIMessage('{"mode":"route","targetKm":800}');
    },
    plan: async (value, _idea, _origin, _label, _progress, options) => {
      plans++; assert.equal(value.targetKm, 30); assert.equal(options?.disableEnroute, true);
      return { message: '已规划', route: base };
    },
    explore: async input => { explores++; assert.equal(input.intent.targetKm, 30); assert.equal(input.result.route, base);
      return { status: 'explored', added: ['顺路绿道'], extraKm: 1, result: { ...input.result, route: optimized, note: '加入顺路绿道' } }; }
  });
  const first = await invokeRaw(controller, { idea: '想骑热门路段约30公里', center: origin, origin });
  const next = await invokeRaw(controller, { idea: '确认，开始规划', center: origin, origin, previousIntent: first.body.contextIntent });
  assert.equal(next.body.route.distanceKm, 30); assert.equal(next.body.contextIntent.targetKm, 30);
  assert.equal(next.body.alternatives[0].route.distanceKm, 31); assert.match(next.body.alternatives[0].note, /顺路绿道/);
  assert.equal(plans, 1); assert.equal(explores, 1);
  assert.deepEqual(next.body.meta.toolCalls.map((call: any) => call.name), ['plan_cycling_route', 'find_enroute_segments']);
});

test('nearby tool evidence controls displayed candidates, radius and location source', async () => {
  let turns = 0, reads = 0;
  const close = { ...segment('1', 'unknown'), lat: origin.lat, lng: origin.lng };
  const far = { ...segment('2', 'unknown'), lat: origin.lat + .2, lng: origin.lng };
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [], resolve: async () => null,
    near: async () => { reads++; return [close, far]; },
    toolCaller: async () => !turns++ ? new AIMessage({ content: '', tool_calls: [{ name: 'search_nearby_candidates', args: { centerId: null, radiusKm: 5, type: 'segment' }, id: 'near' }] }) : new AIMessage('{"mode":"recommend"}'),
    model: async (_prompt, input: any) => ({ items: input.candidates.map((item: Candidate) => ({ id: item.id, reason: '附近候选' })) })
  });
  const result = await invokeRaw(controller, { idea: '查询当前位置5公里内有哪些路段', center: { lat: 30, lng: 120 }, origin, originSource: 'gps' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items.map((item: Candidate) => item.id), [close.id]);
  assert.equal(result.body.area, '当前位置附近'); assert.equal(reads, 1);
  assert.deepEqual(result.body.moreSearch.center, origin);
});

test('nearby tool failure is not silently widened into a default search', async () => {
  let turns = 0, reads = 0;
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [], resolve: async () => null,
    near: async () => { reads++; throw Error('database unavailable'); },
    toolCaller: async () => !turns++ ? new AIMessage({ content: '', tool_calls: [{ name: 'search_nearby_candidates', args: { centerId: null, radiusKm: 5, type: 'segment' }, id: 'near' }] }) : new AIMessage('{"mode":"recommend"}')
  });
  const result = await invokeRaw(controller, { idea: '查找附近5公里的路段', center: origin, origin });
  assert.equal(result.status, 200); assert.match(result.body.message, /无法核实/); assert.deepEqual(result.body.items, []); assert.equal(reads, 1);
});

test('confirmed planning keeps one bounded exploration when the model omits the optional tool', async () => {
  let turns = 0, plans = 0, explores = 0;
  const base = fakeRoute(30, 90);
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [], resolve: async () => null, near: async () => [],
    toolCaller: async () => {
      if (!turns++) return new AIMessage('{"mode":"route","targetKm":30}');
      if (turns === 2) return new AIMessage({ content: '', tool_calls: [{ name: 'plan_cycling_route', args: {}, id: 'plan' }] });
      return new AIMessage('{"mode":"route","targetKm":30}');
    },
    plan: async () => { plans++; return { message: '已规划', route: base }; },
    explore: async input => { explores++; return { status: 'explored', added: [], extraKm: 0, result: input.result }; }
  });
  const first = await invokeRaw(controller, { idea: '骑30公里', center: origin, origin });
  const next = await invokeRaw(controller, { idea: '确认', center: origin, origin, previousIntent: first.body.contextIntent });
  assert.equal(next.body.route.distanceKm, 30); assert.equal(plans, 1); assert.equal(explores, 1);
});

test('a model failure after confirmation falls back to the authoritative planner once', async () => {
  let turns = 0, plans = 0;
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [], resolve: async () => null, near: async () => [],
    toolCaller: async () => { if (!turns++) return new AIMessage('{"mode":"route","targetKm":30}'); throw Error('model unavailable'); },
    plan: async value => { plans++; assert.equal(value.targetKm, 30); return { message: '已规划', route: fakeRoute(30, 90) }; }
  });
  const first = await invokeRaw(controller, { idea: '骑30公里', center: origin, origin });
  const next = await invokeRaw(controller, { idea: '确认', center: origin, origin, previousIntent: first.body.contextIntent });
  assert.equal(next.body.route.distanceKm, 30); assert.equal(plans, 1);
});

test('named-place results retain the nearby tool radius instead of widening the results', async () => {
  let turns = 0;
  const close = { ...segment('11', 'unknown'), lat: origin.lat, lng: origin.lng };
  const far = { ...segment('12', 'unknown'), lat: origin.lat + .2, lng: origin.lng };
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [far], resolve: async () => origin,
    near: async () => [close, far],
    toolCaller: async () => !turns++ ? new AIMessage({ content: '', tool_calls: [
      { name: 'search_candidates', args: { name: '滨江', terms: [] }, id: 'name' },
      { name: 'search_nearby_candidates', args: { centerId: null, radiusKm: 5, type: 'segment' }, id: 'near' }
    ] }) : new AIMessage('{"mode":"answer","lookup":{"name":"滨江","terms":[],"kind":"area"}}')
  });
  const result = await invokeRaw(controller, { idea: '查找滨江附近5公里的路段', center: origin, origin });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items.map((item: Candidate) => item.id), [close.id]);
});

test('an explicit nearby discovery returns real candidate cards even when the model chooses answer mode', async () => {
  let turns = 0;
  const actual = { ...segment('8', 'unknown'), lat: origin.lat, lng: origin.lng };
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [], resolve: async () => null, near: async () => [actual],
    toolCaller: async () => !turns++ ? new AIMessage({ content: '', tool_calls: [{ name: 'search_nearby_candidates', args: { centerId: null, radiusKm: 5, type: 'segment' }, id: 'near' }] }) : new AIMessage('{"mode":"answer","reply":"这是一条回答"}'),
    model: async () => ({ items: [{ id: actual.id, reason: '附近候选' }] })
  });
  const result = await invokeRaw(controller, { idea: '查找附近5公里的路段', center: origin, origin });
  assert.equal(result.body.contextIntent.requestType, 'recommend');
  assert.deepEqual(result.body.items.map((item: Candidate) => item.id), [actual.id]);
});

test('route candidate clarification exposes More beside verified choices and supports expanded selection', async () => {
  const firstCandidate: Candidate = { ...segment('301', 'unknown'), name: '南门景观大堤-崇明沿江观光大堤' };
  const secondCandidate: Candidate = { ...segment('302', 'unknown'), name: '浏河至荡茜河沿江线' };
  const thirdCandidate: Candidate = { ...segment('303', 'unknown'), name: '古田桥至太平洋 沿江大道' };
  const expandedCandidate: Candidate = { ...segment('304', 'unknown'), name: '江边绿道' };
  let turns = 0;
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [firstCandidate, secondCandidate, thirdCandidate], resolve: async () => null, near: async () => [],
    related: async () => [firstCandidate, expandedCandidate],
    model: async () => ({ terms: ['江', 'yanjiang', 'river'] }),
    toolCaller: async () => {
      if (!turns++) return new AIMessage({ content: '', tool_calls: [{ name: 'search_candidates', args: { name: '沿江', terms: [] }, id: 'search' }] });
      if (turns === 2) return new AIMessage(JSON.stringify({ mode: 'clarify', requestType: 'route', clarificationKind: 'scope', targetKm: 30,
        lookup: { name: '沿江', terms: [], kind: 'ambiguous' }, reply: '请选择城市', options: ['上海崇明沿江观光大堤', '上海浏河至荡茜河沿江线', '武汉沿江大道古田桥至太平洋'] }));
      if (turns === 3) return new AIMessage({ content: '', tool_calls: [{ name: 'get_candidate_detail', args: { id: expandedCandidate.id }, id: 'detail' }] });
      return new AIMessage(JSON.stringify({ mode: 'route', requestType: 'route', targetKm: 30, selectedCandidateId: expandedCandidate.id, needsSegment: true, segmentName: expandedCandidate.name }));
    },
    byId: async id => [firstCandidate, secondCandidate, thirdCandidate, expandedCandidate].find(item => item.id === id) || null
  });
  const first = await invokeRaw(controller, { idea: '帮我规划一条沿江的骑行路线', center: origin, origin });
  assert.deepEqual(first.body.options, [`选择${firstCandidate.name}`, `选择${secondCandidate.name}`, `选择${thirdCandidate.name}`]);
  assert.equal(first.body.moreSearch.query, '沿江'); assert.deepEqual(first.body.moreSearch.center, origin);
  const more = await invokeRaw(controller, { idea: '查看更多相关路段和地点', center: origin, origin,
    previousIntent: first.body.contextIntent, placeContext: first.body.placeContext, moreSearch: first.body.moreSearch });
  assert.deepEqual(more.body.items.map((item: Candidate) => item.id), [expandedCandidate.id]);
  assert.equal(more.body.contextIntent.targetKm, 30);
  const selected = await invokeRaw(controller, { idea: `选择${expandedCandidate.name}`, center: origin, origin, previousIntent: more.body.contextIntent, placeContext: more.body.placeContext });
  assert.equal(selected.body.placeContext.selectedId, expandedCandidate.id);
  assert.equal(selected.body.contextIntent.confirmationPending, true);
  assert.equal(selected.body.contextIntent.targetKm, 30);
});

test('more search is also offered for a previously unresolved route candidate', async () => {
  const candidate = segment('91', 'unknown');
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'route', requestType: 'route', targetKm: 30 }), search: async () => [candidate], resolve: async () => null, near: async () => [] });
  const response = await invokeRaw(controller, { idea: '规划路线', center: origin, origin, placeContext: { query: '沿江', candidates: [{ id: candidate.id, type: candidate.type, name: candidate.name }], selectedId: null } });
  assert.equal(response.body.moreSearch.query, '沿江');
  assert.ok(response.body.options.some((option: string) => option.includes(candidate.name)));
});

test('real distance scope clarification does not turn into candidate selection', async () => {
  const candidate = { ...segment('92', 'unknown'), name: '沿江50公里路线' };
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [candidate], resolve: async () => null, near: async () => [],
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'scope', lookup: { name: '沿江', terms: [], kind: 'segment' },
      reply: '50公里是全程还是到达后骑行？', options: ['全程50公里', '到达后骑50公里'] }) });
  const response = await invokeRaw(controller, { idea: '到沿江后骑50公里', center: origin, origin });
  assert.match(response.body.message, /全程还是/); assert.equal(response.body.moreSearch, undefined);
  assert.deepEqual(response.body.options, ['全程50公里', '到达后骑50公里']);
});

test('candidate clarification replaces unmatched model suggestions with verified records and offers More', async () => {
  const candidate = { ...segment('96', 'unknown'), name: '真实沿江绿道' };
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [candidate], resolve: async () => null, near: async () => [],
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'scope', lookup: { name: '沿江', terms: [], kind: 'ambiguous' },
      reply: '请选择想骑的那一处，或告诉我具体位置。', options: ['模型臆造地点甲', '模型臆造地点乙'] }) });
  const response = await invokeRaw(controller, { idea: '帮我规划一条沿江的骑行路线', center: origin, origin });
  assert.deepEqual(response.body.options, [`选择${candidate.name}`]);
  assert.doesNotMatch(response.body.message, /臆造/);
  assert.equal(response.body.moreSearch.query, '沿江');
});

test('stop ordering clarification stays an ordering question even with a grounded candidate name', async () => {
  const candidate = { ...segment('97', 'unknown'), name: '示例滨江骑行路段' };
  const controller = createIdeaController({ isConfigured: () => true, search: async () => [candidate], resolve: async () => null, near: async () => [],
    model: async () => ({ mode: 'clarify', requestType: 'route', clarificationKind: 'order', lookup: { name: '滨江', terms: [], kind: 'ambiguous' },
      reply: '你想先去哪里？', options: ['先骑示例滨江骑行路段后去咖啡店', '先去咖啡店后骑示例滨江骑行路段'] }) });
  const response = await invokeRaw(controller, { idea: '骑滨江路段并去咖啡店', center: origin, origin });
  assert.equal(response.body.message, '你想先去哪里？'); assert.equal(response.body.moreSearch, undefined);
  assert.equal(response.body.options[0], '先骑示例滨江骑行路段后去咖啡店');
});

test('explains a provider quota failure instead of blaming the selected waypoint', async () => {
  const { RouteConnectionError } = await import('../services/ideaRouteService');
  const chosen = segment('81', 'unknown');
  const result: any = await planFromIntent(intent({ needsSegment: true, segmentName: chosen.name }), '经过路段骑行', origin, 'gps', () => {}, {
    resolve: async () => origin, named: async () => [chosen], model: async () => ({ ids: [chosen.id] }),
    build: async () => { throw new RouteConnectionError('quota_exhausted', 'to_first_stop', 'private details'); }
  });
  assert.match(result.message, /额度|到期/); assert.doesNotMatch(result.message, /private details/);
  assert.deepEqual(result.options, ['重试规划', '调整途经点']);
});

test('distinguishes disconnected endpoints from transient map failures', async () => {
  const { RouteConnectionError } = await import('../services/ideaRouteService');
  const chosen = segment('82', 'unknown');
  const overrides = { resolve: async () => origin, named: async () => [chosen], model: async () => ({ ids: [chosen.id] }) };
  const mismatch: any = await planFromIntent(intent({ needsSegment: true, segmentName: chosen.name }), '经过路段骑行', origin, 'gps', () => {}, {
    ...overrides, build: async () => { throw new RouteConnectionError('endpoint_mismatch', 'to_first_stop', 'gap'); }
  });
  assert.match(mismatch.message, /间隔超过 100 米/);
  const temporary: any = await planFromIntent(intent({ needsSegment: true, segmentName: chosen.name }), '经过路段骑行', origin, 'gps', () => {}, {
    ...overrides, build: async () => { throw new RouteConnectionError('temporarily_unavailable', 'to_first_stop', 'timeout'); }
  });
  assert.match(temporary.message, /自动重试/); assert.doesNotMatch(temporary.message, /timeout/);
});

test('reuses identical navigation requests across route alternatives', async () => {
  const candidates = [segment('201', 'unknown'), segment('202', 'unknown'), segment('203', 'unknown')];
  const destination = { lat: 31.21, lng: 121.41 };
  let calls = 0, builds = 0;
  const result: any = await planFromIntent(intent({ needsSegment: true, segmentName: '沿江' }), '想骑沿江路段', origin, 'gps', () => {}, {
    resolve: async () => origin, named: async () => candidates, model: async () => ({ ids: candidates.map(item => item.id) }),
    navigate: async (a, b) => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return [{ points: [a, b], polyline: 'x', distanceKm: 3, durationMin: 10 }]; },
    build: async (_a, _an, _b, _bn, _stops, navigate) => { builds++; await navigate!(origin, destination); return fakeRoute(30, 90); }
  });
  assert.equal(result.route.distanceKm, 30); assert.equal(builds, 3); assert.equal(calls, 1);
});

test('confirmed selection is refreshed by ID without repeating name or location searches', async () => {
  const selected = segment('116', 'unknown'); let reads = 0, planned = 0, turns = 0;
  const controller = createIdeaController({ isConfigured: () => true,
    search: async () => { throw Error('unnecessary broad search'); }, resolve: async () => { throw Error('unnecessary map lookup'); },
    byId: async id => { reads++; return id === selected.id ? selected : null; }, near: async () => [],
    toolCaller: async () => !turns++ ? new AIMessage({ content: '', tool_calls: [{ name: 'plan_cycling_route', args: {}, id: 'plan' }] }) : new AIMessage('{"mode":"route"}'),
    plan: async (_intent, _idea, _origin, _label, _progress, overrides) => {
      planned++; assert.equal((await overrides!.named!(origin, selected.name))[0].id, selected.id);
      return { message: '已规划', route: fakeRoute(30, 90) };
    }
  });
  const response = await invokeRaw(controller, { idea: '确认，开始规划', center: origin, origin,
    previousIntent: { mode: 'route', requestType: 'route', confirmationPending: true, needsSegment: true, segmentName: selected.name, stops: [{ type: 'segment', name: selected.name }] },
    placeContext: { query: '沿江', selectedId: selected.id, candidates: [{ id: selected.id, type: selected.type, name: selected.name }] } });
  assert.equal(response.status, 200); assert.equal(response.body.message, '已规划');
  assert.equal(reads, 1); assert.equal(planned, 1);
});

test('a selected candidate that becomes unavailable is not silently replaced on confirmation', async () => {
  const selected = segment('117', 'unknown'); let planned = false, searches = 0;
  const controller = createIdeaController({ isConfigured: () => true, byId: async () => null,
    search: async () => { searches++; return [segment('118', 'unknown')]; }, resolve: async () => null, near: async () => [],
    plan: async () => { planned = true; return {}; } });
  const response = await invokeRaw(controller, { idea: '确认，开始规划', center: origin, origin,
    previousIntent: { mode: 'route', requestType: 'route', confirmationPending: true, needsSegment: true, segmentName: selected.name },
    placeContext: { query: '沿江', selectedId: selected.id, candidates: [{ id: selected.id, type: selected.type, name: selected.name }] } });
  assert.match(response.body.message, /已不可用/); assert.equal(planned, false); assert.equal(searches, 0);
});

test('streams the first route before alternatives and preserves it if exploration fails', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const exploring = new Promise<void>(resolve => { started = resolve; });
  const baseline = fakeRoute(30, 90), alternate = fakeRoute(31, 95);
  const controller = createIdeaController({ isConfigured: () => true,
    model: async () => ({ mode: 'route', targetKm: 30 }),
    plan: async () => ({ message: '已规划', route: baseline }),
    explore: async input => {
      started(); await gate;
      input.onAlternative?.({ status: 'explored', added: ['顺路绿道'], extraKm: 1, result: { route: alternate } });
      throw Error('后续搜索失败');
    }
  });
  const first = await invokeRaw(controller, { idea: '骑30公里', center: origin, origin });
  const events: string[] = [];
  const req = { body: { idea: '确认', center: origin, origin, previousIntent: first.body.contextIntent }, get: () => 'text/event-stream' } as unknown as Request;
  const response = { destroyed: false, status() { return this; }, set() { return this; }, flushHeaders() {},
    write(value: string) { events.push(value); return true; }, end() { return this; } } as unknown as Response;
  const pending = controller(req, response);
  await exploring;
  assert.ok(events.some(event => event.startsWith('event: route_first\n')));
  assert.ok(events.some(event => event.startsWith('event: route_alternatives_progress\n')));
  assert.ok(!events.some(event => event.startsWith('event: result\n')));
  release(); await pending;
  const types = events.map(event => event.match(/^event: (.+)/)?.[1]);
  assert.ok(types.indexOf('route_first') < types.indexOf('route_alternative'));
  assert.ok(types.indexOf('route_alternative') < types.indexOf('route_alternatives_done'));
  assert.ok(types.indexOf('route_alternatives_done') < types.indexOf('result'));
  const finalEvent = events.find(event => event.startsWith('event: result\n'))!;
  const payload = JSON.parse(finalEvent.match(/\ndata: (.+)/)![1]);
  assert.equal(payload.route.distanceKm, 30);
  assert.equal(payload.alternatives.length, 1);
  assert.equal(payload.alternatives[0].route.distanceKm, 31);
  assert.equal(payload.alternativeStatus, 'unavailable');
});

test('recommendations use route attributes even when segment names do not contain the requested type', async () => {
  const matched = { ...segment('71', 'unknown'), name: '公园东路', tags: { ...unknownRouteTags(), loop: 'matched' as const } };
  const other = { ...segment('72', 'unknown'), name: '环线名字但不是绕圈', tags: { ...unknownRouteTags(), loop: 'not_matched' as const } };
  let observed: any;
  const controller = createIdeaController({ isConfigured: () => true,
    model: async (_prompt, input: any) => input.candidates ? { items: [{ id: other.id, reason: '候选' }, { id: matched.id, reason: '候选' }] } : { mode: 'recommend', preferredTags: ['loop'] },
    near: async (_center, _radius, preferences) => { observed = preferences; return [other, matched]; }
  });
  const result = await invokeRaw(controller, { idea: '推荐绕圈路段', center: origin, origin });
  assert.deepEqual(observed.preferred, ['loop']);
  assert.deepEqual(result.body.items.map((item: Candidate) => item.id), [matched.id, other.id]);
});
