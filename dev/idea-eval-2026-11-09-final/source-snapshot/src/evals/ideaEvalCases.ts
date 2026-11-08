import type { IdeaEvalCase, EvalExpectation } from './ideaEvaluation';

export const IDEA_EVAL_DATASET_VERSION = 'idea-business-v1';
const cases: IdeaEvalCase[] = [];
const add = (id: string, category: string, idea: string, fields: Record<string, unknown> = {}, extra: EvalExpectation = {}) => {
  cases.push({ id, category, split: 'development', turns: [{ idea, expect: { fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`contextIntent.${key}`, value])), ...extra } }] });
};
// Manually specified requirements; expected outputs do not come from the model being evaluated.
for (const [id, idea, km] of [
  ['distance-20', '我想骑20公里', 20], ['distance-30', '轻松骑三十公里', 30], ['distance-50', '骑50公里', 50],
  ['distance-80', '今天想骑八十公里', 80], ['distance-decimal', '骑25.5公里', 25.5], ['distance-unspecified', '我想骑车', null]
] as const) add(id, 'distance', idea, { targetKm: km, requestType: 'route' });
for (const [id, idea, fields] of [
  ['range-target', '骑50公里，范围40到60公里', { targetKm: 50, minKm: 40, maxKm: 60 }],
  ['range-only', '骑40到60公里', { targetKm: null, minKm: 40, maxKm: 60 }],
  ['range-upper', '最多骑35公里', { maxKm: 35 }], ['range-lower', '至少骑45公里', { minKm: 45 }],
  ['range-tight', '目标30公里，最少28最多32公里', { targetKm: 30, minKm: 28, maxKm: 32 }],
  ['range-unchosen', '随便骑一圈，不限定公里数', { targetKm: null, minKm: null, maxKm: null }]
] as Array<[string, string, Record<string, unknown>]>) add(id, 'bounds', idea, fields);
for (const [id, idea, fields] of [
  ['time-two-hours', '骑两小时', { targetMinutes: 120 }], ['time-half-hour', '骑半小时', { targetMinutes: 30 }],
  ['time-ninety', '骑一个半小时', { targetMinutes: 90 }], ['time-cap', '两小时内回来', { maxMinutes: 120, timeScope: 'total' }],
  ['time-riding', '只算骑车时间，骑90分钟', { targetMinutes: 90, timeScope: 'riding' }],
  ['time-stops', '含休息20分钟，两小时内回来', { maxMinutes: 120, stopMinutes: 20, timeScope: 'total' }],
  ['time-range', '骑行时间60到90分钟', { minMinutes: 60, maxMinutes: 90 }],
  ['distance-and-time', '骑30公里，骑行时间最多120分钟', { targetKm: 30, maxMinutes: 120 }]
] as Array<[string, string, Record<string, unknown>]>) add(id, 'time', idea, fields);
for (const [id, idea, fields] of [
  ['prefer-climb', '找爬坡训练路段', { preferredTags: ['climbing'] }], ['avoid-climb', '规划路线，不要爬坡', { avoidTags: ['climbing'] }],
  ['prefer-popular', '骑热门路段', { preferredTags: ['popular'], needsSegment: true }], ['prefer-starred', '推荐收藏多的路段', { preferredTags: ['highly_starred'] }],
  ['prefer-long', '推荐长距离路段', { preferredTags: ['long_distance'] }], ['prefer-loop', '找适合刷圈训练的路段', { preferredTags: ['loop'] }],
  ['prefer-outback', '推荐原路往返路段', { preferredTags: ['out_and_back'] }], ['roundtrip-not-loop-tag', '骑30公里绕一圈回来', { targetKm: 30, preferredTags: [] }]
] as Array<[string, string, Record<string, unknown>]>) add(id, 'preference', idea, fields);
for (const [id, idea, fields] of [
  ['origin', '从人民广场出发骑30公里', { origin: '人民广场', targetKm: 30 }],
  ['destination', '骑车到世纪公园结束', { destination: '世纪公园' }],
  ['explicit-return', '从人民广场出发，最后返回出发地', { origin: '人民广场', returnToStart: true }],
  ['default-end', '轻松骑行，不指定目的地', { origin: null, destination: null }],
  ['point-kind', '规划路线，中途找咖啡店', { needsPoint: true, pointKind: '咖啡店' }],
  ['ordered-stops', '先骑滨江练习段，再到补给咖啡站', { stops: [{ type: 'segment', name: '滨江练习段', kind: null }, { type: 'point', name: '补给咖啡站', kind: null }] }]
] as Array<[string, string, Record<string, unknown>]>) add(id, 'entities', idea, fields);
for (const [id, first, second, fields] of [
  ['modify-distance', '骑50公里', '改成30公里', { targetKm: 30 }], ['keep-distance', '骑50公里', '想轻松一点', { targetKm: 50 }],
  ['modify-time', '骑两小时', '改成一个小时', { targetMinutes: 60 }],
  ['keep-avoidance', '规划路线，不要爬坡', '目标40公里', { targetKm: 40, avoidTags: ['climbing'] }],
  ['add-time', '骑40公里', '最多两个小时，含停留', { targetKm: 40, maxMinutes: 120, timeScope: 'total' }],
  ['keep-stop-time', '两小时内回来，休息20分钟', '距离大概30公里', { targetKm: 30, stopMinutes: 20, maxMinutes: 120 }],
  ['new-conversation', '骑50公里，想爬坡', '重新开始，轻松骑20公里', { targetKm: 20, preferredTags: [] }],
  ['modify-bounds', '骑40到60公里', '范围改成20到30公里', { minKm: 20, maxKm: 30 }],
  ['keep-origin', '从人民广场出发骑30公里', '改成40公里', { origin: '人民广场', targetKm: 40 }],
  ['cancel-distance', '骑50公里', '取消距离要求，随便骑一圈', { targetKm: null, minKm: null, maxKm: null }]
] as Array<[string, string, string, Record<string, unknown>]>) cases.push({ id, category: 'multi_turn', split: 'development', turns: [
  { idea: first, expect: {} }, { idea: second, expect: { fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`contextIntent.${key}`, value])) } }
] });
for (const [id, idea, candidateIds] of [
  ['lookup-segment', '介绍一下滨江练习段', ['segment:101']], ['lookup-point', '补给咖啡站在哪里', ['point:201']],
  ['lookup-many', '查一下滨江有哪些路段', ['segment:101', 'segment:102']], ['lookup-missing', '查询不存在的星际绿道路段', []]
] as Array<[string, string, string[]]>) add(id, 'lookup', idea, {}, { candidateIds, toolAnyOf: ['search_candidates'], noRoute: true });
for (const [id, second, selected] of [
  ['select-first', '选第一个，规划骑30公里', 'segment:101'], ['select-second', '选第二个，规划骑30公里', 'segment:102'],
  ['select-name', '选择城市绕圈段，规划骑30公里', 'segment:102']
]) cases.push({ id, category: 'selection', split: 'holdout', turns: [
  { idea: '查一下滨江有哪些路段', expect: { candidateIds: ['segment:101', 'segment:102'] } },
  { idea: second, expect: { fields: { 'placeContext.selectedId': selected, 'contextIntent.targetKm': 30 }, toolAnyOf: ['get_candidate_detail'] } }
] });
add('general-strava', 'answer', '什么是Strava路段', {}, { noRoute: true });
add('general-gpx', 'answer', 'GPX文件是什么', {}, { noRoute: true });
add('general-slope', 'answer', '骑行中的平均坡度是什么意思', {}, { noRoute: true });
add('no-invented-budget', 'boundary', '推荐附近热门路段，但我没说想骑多远', { targetKm: null, preferredTags: ['popular'] });
add('negation', 'boundary', '不要推荐爬坡路段，推荐热门的', { avoidTags: ['climbing'], preferredTags: ['popular'] });
add('unknown-popularity', 'boundary', '推荐附近路段，不要求热门', { preferredTags: [] });
add('units-distance', 'units', '轻松骑三十千米', { targetKm: 30 });
add('units-duration', 'units', '骑两个半小时', { targetMinutes: 150 });
add('unknown-stop-duration', 'units', '两小时内回来，包括中途休息但时间没定', { maxMinutes: 120, timeScope: 'total', stopMinutes: null });

if (cases.length !== 60) throw new Error('Evaluation dataset must contain 60 unique scenarios');
export const IDEA_EVAL_CASES: IdeaEvalCase[] = cases.map((item, index) => ({ ...item, split: index < 40 ? 'development' : 'holdout' }));
