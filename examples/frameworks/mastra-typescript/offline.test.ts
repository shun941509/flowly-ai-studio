import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
import { lookupRelease, runRelease } from './main.ts';

test('OFFLINE: 실제 Mastra Agent가 조회하고 결과를 다음 모델 호출로 전달한다', async () => {
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
  const model = new MockLanguageModelV4({ doGenerate: [
    { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookupRelease', input: '{"release_id":"release-2026-10"}' }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] },
    { content: [{ type: 'text', text: 'hold: migration-backup 누락, accessibility 실패. 근거 REL-001.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
  ] });
  const called: string[] = []; const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('검사 중 네트워크 금지'); };
  try {
    const result = await runRelease('release-2026-10 확인', model, id => called.push(id));
    assert.deepEqual(called, ['release-2026-10']); assert.match(result.answer, /hold/);
    assert.match(JSON.stringify(model.doGenerateCalls[1].prompt), /migration-backup/);
  } finally { globalThis.fetch = original; }
});
test('없는 릴리스를 출시 가능으로 처리하지 않는다', () => {
  assert.equal(lookupRelease('release-2099-01').decision, 'unknown');
});

