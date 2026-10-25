import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Agent, Runner, setTracingDisabled, tool, type Model } from '@openai/agents';
import { z } from 'zod';
import { configuration, requireConfiguration, safeError } from './config.ts';

setTracingDisabled(true);
const records = JSON.parse(readFileSync(new URL('./fixtures/shipments.json', import.meta.url), 'utf8'));
export function lookupShipment(orderId: string) {
  if (!/^ORD-\d{4}-\d{3}$/.test(orderId)) throw new Error('주문 번호 형식 오류');
  return records[orderId] ?? { order_id: orderId, status: 'not_found', source_id: null };
}
export async function runShipment(input: string, model: string | Model, onLookup?: (id: string) => void) {
  if (!input.trim() || input.length > 4000) throw new Error('입력은 1~4000자여야 합니다.');
  let calls = 0;
  const lookup = tool({ name: 'lookup_shipment', description: '로컬 배송 스냅샷에서 주문 번호를 읽기 전용 조회합니다.',
    parameters: z.object({ order_id: z.string().regex(/^ORD-\d{4}-\d{3}$/) }),
    execute: async ({ order_id }) => {
      if (++calls > 3) throw new Error('조회 한도 초과');
      onLookup?.(order_id); return JSON.stringify(lookupShipment(order_id));
    } });
  const agent = new Agent({ name: '배송 상태 안내', model,
    instructions: '질문에 있는 주문 번호를 lookup_shipment로 조회하고 상태, 예정일, source_id를 한국어로 답하세요. 조회 전에는 상태를 추정하지 마세요. not_found는 조회 자료 없음으로 답하세요. 배송 상태 변경은 제공하지 않습니다.',
    tools: [lookup], modelSettings: { maxTokens: 800, parallelToolCalls: false } });
  const result = await new Runner({ tracingDisabled: true }).run(agent, input, { maxTurns: 4, signal: AbortSignal.timeout(60000) });
  if (!calls) throw new Error('필수 배송 조회 도구가 호출되지 않았습니다.');
  return { answer: result.finalOutput, toolCalls: calls, source: 'local_snapshot' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'check') console.log(JSON.stringify({ ...configuration(), providerVerified: false }));
    else if (process.argv[2] === 'run') console.log(JSON.stringify(await runShipment(process.argv.slice(3).join(' ') || '주문 ORD-2026-001의 배송 상태와 예상일을 알려주세요', requireConfiguration())));
    else throw new Error('사용법: pnpm check 또는 pnpm start -- 질문');
  } catch (error) { safeError(error); }
}
