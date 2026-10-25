import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runKnowledge } from './main.ts';
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { throw new Error('오프라인 검사 중 네트워크 금지'); }; });
test.after(() => { globalThis.fetch = originalFetch; });
test('OFFLINE: 실제 LangGraph 조건 경로와 조회 결과 전달', async () => {
  const result = await runKnowledge('급여 파일 접근 권한이 없어요', async () => ({ category: 'access' }));
  assert.equal(result.category, 'access'); assert.match(result.answer, /관리자 승인/); assert.match(result.evidence, /ACC-01/);
});
test('모르는 질문은 근거 없는 답변을 만들지 않는다', async () => {
  const result = await runKnowledge('내일 주가', async () => ({ category: 'unknown' }));
  assert.equal(result.evidence, ''); assert.match(result.answer, /담당자/);
});
test('분류 응답 스키마 위반을 거절한다', async () => {
  await assert.rejects(runKnowledge('질문', async () => ({ category: 'invented' as 'access' })));
});
