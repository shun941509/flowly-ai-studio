import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import type { MastraModelConfig } from '@mastra/core/llm';
import { z } from 'zod';
import { configuration, requireConfiguration, safeError } from './config.ts';

const releases = JSON.parse(readFileSync(new URL('./fixtures/releases.json', import.meta.url), 'utf8'));
export function lookupRelease(releaseId: string) {
  return releases[releaseId] ?? { release_id: releaseId, decision: 'unknown', checks: [], source_id: null };
}
export async function runRelease(input: string, model: MastraModelConfig, onLookup?: (id: string) => void) {
  if (!input.trim() || input.length > 4000) throw new Error('입력 길이 오류');
  let calls = 0;
  const lookup = createTool({ id: 'lookup-release', description: '릴리스 검사 결과 스냅샷 읽기. 출시하거나 수정하지 않습니다.',
    inputSchema: z.object({ release_id: z.string().regex(/^release-\d{4}-\d{2}$/) }),
    execute: async ({ release_id }) => { if (++calls > 3) throw new Error('조회 한도 초과'); onLookup?.(release_id); return lookupRelease(release_id); } });
  const agent = new Agent({ id: 'release-readiness', name: '출시 준비 검토', model,
    instructions: 'lookupRelease 도구로 검사 결과를 확인하세요. 필수 검사에 missing 또는 failed가 있으면 hold로 답하고 각 원인을 적으세요. source_id를 인용하세요. 배포 실행이나 승인 완료를 주장하지 마세요.',
    tools: { lookupRelease: lookup } });
  const result = await agent.generate(input, { maxSteps: 4, modelSettings: { maxOutputTokens: 800 }, abortSignal: AbortSignal.timeout(60000) });
  if (!calls) throw new Error('필수 릴리스 조회가 실행되지 않았습니다.');
  return { answer: result.text, toolCalls: calls, source: 'local_snapshot' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'check') console.log(JSON.stringify({ ...configuration(), providerVerified: false }));
    else if (process.argv[2] === 'run') console.log(JSON.stringify(await runRelease(process.argv.slice(3).join(' ') || 'release-2026-10 후보의 필수 검사 결과와 출시 보류 이유를 정리해 주세요', `openai/${requireConfiguration()}`)));
    else throw new Error('사용법: pnpm check 또는 pnpm start -- 질문');
  } catch (error) { safeError(error); }
}
