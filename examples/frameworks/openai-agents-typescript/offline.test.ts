import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Usage, type Model, type ModelRequest, type ModelResponse } from '@openai/agents';
import { lookupShipment, runShipment } from './main.ts';

class OfflineModel implements Model {
  requests: ModelRequest[] = [];
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const output: ModelResponse['output'] = this.requests.length === 1
      ? [{ type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'lookup_shipment', arguments: '{"order_id":"ORD-2026-001"}', status: 'completed' }]
      : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '운송 중, 예정일 2026-10-24, 근거 SHIP-001' }] }];
    return { output, usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 }) };
  }
  async *getStreamedResponse(): AsyncGenerator<never> { throw new Error('오프라인 검사에서 스트리밍을 사용하지 않습니다.'); }
}
test('OFFLINE: 실제 SDK Runner가 도구를 실행하고 결과를 모델 다음 턴에 전달한다', async () => {
  const model = new OfflineModel(); const called: string[] = [];
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error('검사 중 네트워크 금지'); };
  try {
    const result = await runShipment('ORD-2026-001 조회', model, id => called.push(id));
    assert.deepEqual(called, ['ORD-2026-001']); assert.equal(result.toolCalls, 1);
    assert.match(result.answer!, /SHIP-001/); assert.match(JSON.stringify(model.requests[1].input), /2026-10-24/);
  } finally { globalThis.fetch = original; }
});
test('없는 주문과 잘못된 주문 번호를 구분한다', () => {
  assert.equal(lookupShipment('ORD-2026-999').status, 'not_found');
  assert.throws(() => lookupShipment('../secret'));
});
