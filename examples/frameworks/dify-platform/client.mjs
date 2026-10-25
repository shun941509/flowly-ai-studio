import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
export function configuration() {
  if (existsSync('.env')) loadEnvFile('.env');
  const missing = ['DIFY_API_BASE', 'DIFY_API_KEY', 'DIFY_USER'].filter(key => !process.env[key]?.trim());
  return { ready: !missing.length, missing, providerVerified: false };
}
export function validateBase(base) {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('안전한 Dify API 주소가 필요합니다.');
  return url.href.replace(/\/$/, '');
}
export function parseResult(body) {
  if (body?.data?.status !== 'succeeded') throw new Error('Dify 워크플로가 성공하지 않았습니다. 실행 기록을 확인하세요.');
  const result = typeof body.data.outputs?.result === 'string' ? JSON.parse(body.data.outputs.result) : body.data.outputs?.result;
  if (!result || !['billing', 'account', 'technical', 'other'].includes(result.category) || !['normal', 'high'].includes(result.urgency) || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 1000) throw new Error('Dify 출력 스키마 오류');
  return { workflowRunId: body.workflow_run_id, result };
}
export async function runTicket(query, config, fetcher = fetch) {
  if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('입력 길이 오류');
  if (!config.key?.trim() || !config.user?.trim() || config.user.length > 128) throw new Error('Dify 키 또는 사용자 식별자 미설정');
  const response = await fetcher(`${validateBase(config.base)}/workflows/run`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000), headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ inputs: { query }, response_mode: 'blocking', user: config.user }) });
  if (!response.ok) throw new Error(`Dify 요청 실패 (HTTP ${response.status})`);
  return parseResult(await response.json());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration();
  try {
    if (process.argv[2] === 'check') console.log(JSON.stringify(config));
    else if (!config.ready) { console.error(`미설정: ${config.missing.join(', ')}`); process.exitCode = 2; }
    else if (process.argv[2] === 'run') console.log(JSON.stringify(await runTicket(process.argv.slice(3).join(' '), { base: process.env.DIFY_API_BASE, key: process.env.DIFY_API_KEY, user: process.env.DIFY_USER })));
    else throw new Error('명령 오류');
  } catch { console.error('실행 실패: Dify 발행·모델·API 설정 또는 출력 형식을 확인하세요. 자동 재시도하지 않았습니다.'); process.exitCode = 1; }
}
