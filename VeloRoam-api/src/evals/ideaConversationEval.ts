/** Run against a configured local API: npm run eval:idea. Makes real AI/API calls. */
const endpoint = `${process.env.IDEA_EVAL_API_URL || 'http://127.0.0.1:3000'}/api/routes/idea-recommendations`;
const center = { lat: 31.2, lng: 121.4 };
type Result = { message?: string; options?: string[]; contextIntent?: any; error?: string };
async function ask(idea: string, history: Array<{ role: string; content: string }> = [], previousIntent: unknown = null): Promise<Result> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea, center, history, previousIntent }) });
  const result = await response.json() as Result;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || 'request failed'}`);
  return result;
}
async function main() {
  let failures = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${name}: ${detail}\n`);
    if (!condition) failures++;
  };
  const unclear = await ask('我想骑车，帮我推荐一下');
  check('模糊需求追问', Array.isArray(unclear.options) && unclear.options.length > 0, unclear.message || '无回复');
  const answer = await ask('什么是 Strava 路段？');
  check('一般问题直接回答', !!answer.message && !answer.options?.length, answer.message || '无回复');
  const missingEnd = await ask('帮我规划骑行路线，先经过咖啡店');
  check('缺少终点追问', Array.isArray(missingEnd.options) && missingEnd.options.length > 0, missingEnd.message || '无回复');
  if (missingEnd.contextIntent) {
    const followup = await ask('骑完返回起点', [{ role: 'user', content: '帮我规划骑行路线，先经过咖啡店' }, { role: 'assistant', content: missingEnd.message || '' }], missingEnd.contextIntent);
    check('多轮保留途经点与返程', followup.contextIntent?.returnToStart === true && (followup.contextIntent?.needsPoint === true || followup.contextIntent?.stops?.some((s: any) => s.type === 'point')), followup.message || '无回复');
  } else check('多轮保留途经点与返程', false, '上一轮缺少需求上下文');
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error('评测未完成：', error.message); process.exitCode = 1; });
export {};
