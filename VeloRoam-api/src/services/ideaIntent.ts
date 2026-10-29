export type ClarificationKind = 'purpose' | 'destination' | 'order' | 'preference';

// Fallbacks are only used when the model asks a question but omits usable choices.
export function clarificationOptions(value: unknown, kind: unknown): string[] {
  const options = Array.isArray(value) ? value.filter((option): option is string => typeof option === 'string' && !!option.trim()).map(option => option.trim().slice(0, 80)) : [];
  if (options.length) return [...new Set(options)].slice(0, 3);
  switch (kind as ClarificationKind) {
    case 'destination': return ['骑完返回起点', '我想指定结束地点'];
    case 'order': return ['先骑路段，再去途经点', '先去途经点，再骑路段'];
    case 'preference': return ['轻松休闲骑行', '想骑热门路段', '希望途中有休息补给'];
    default: return ['规划完整骑行路线', '推荐骑行路段', '推荐休息补给点'];
  }
}
