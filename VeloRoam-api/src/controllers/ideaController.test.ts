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
  assert.match(constrained.message, /没有找到符合里程或时间要求/);
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
