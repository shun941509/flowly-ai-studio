import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { configuration, requireConfiguration, safeError } from './config.ts';

// This downloadable example does not upload traces, including from inherited shell settings.
process.env.LANGSMITH_TRACING = 'false';
process.env.LANGCHAIN_TRACING_V2 = 'false';

const categorySchema = z.object({ category: z.enum(['access', 'leave', 'unknown']) });
const policies = JSON.parse(readFileSync(new URL('./fixtures/policies.json', import.meta.url), 'utf8'));
export type Classifier = (question: string) => Promise<z.infer<typeof categorySchema>>;
const State = Annotation.Root({ question: Annotation<string>(), category: Annotation<string>(), evidence: Annotation<string>(), answer: Annotation<string>() });
export function createKnowledgeGraph(classify: Classifier) {
  return new StateGraph(State)
    .addNode('classify', async s => categorySchema.parse(await classify(s.question)))
    .addNode('lookup', s => ({ evidence: JSON.stringify(policies[s.category]) }))
    .addNode('compose', s => { const policy = JSON.parse(s.evidence); return { answer: `${policy.text} [${policy.id}]` }; })
    .addNode('escalate', () => ({ evidence: '', answer: '근거 자료 없음: 담당자에게 문의해 주세요.' }))
    .addEdge(START, 'classify')
    .addConditionalEdges('classify', s => s.category === 'unknown' ? 'escalate' : 'lookup', ['escalate', 'lookup'])
    .addEdge('lookup', 'compose').addEdge('compose', END).addEdge('escalate', END).compile();
}
export async function runKnowledge(question: string, classify: Classifier) {
  if (!question.trim() || question.length > 4000) throw new Error('입력 길이 오류');
  return createKnowledgeGraph(classify).invoke({ question }, { recursionLimit: 8, signal: AbortSignal.timeout(60000) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'check') console.log(JSON.stringify({ ...configuration(), providerVerified: false }));
    else if (process.argv[2] === 'run') {
      const model = new ChatOpenAI({ model: requireConfiguration(), maxTokens: 200, maxRetries: 0, timeout: 45000 }).withStructuredOutput(categorySchema);
      const classify: Classifier = q => model.invoke(`문의 종류를 access(접근 권한), leave(휴가), unknown(그 외)으로 분류하세요. 요청문: ${q}`);
      console.log(JSON.stringify(await runKnowledge(process.argv.slice(3).join(' ') || '급여 파일 접근 권한이 없어요', classify)));
    } else throw new Error('사용법: pnpm check 또는 pnpm start -- 질문');
  } catch (error) { safeError(error); }
}
