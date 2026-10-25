import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
export function configuration() {
  if (existsSync('.env')) loadEnvFile('.env');
  const missing = ['OPENAI_API_KEY', 'FLOWLY_MODEL'].filter(key => !process.env[key]?.trim());
  return { ready: missing.length === 0, missing, model: process.env.FLOWLY_MODEL };
}
export function requireConfiguration() {
  const config = configuration();
  if (!config.ready) throw new Error(`미설정: ${config.missing.join(', ')}를 내보낸 프로젝트의 .env에 등록하세요.`);
  return config.model!;
}
export function safeError(error: unknown) {
  console.error(error instanceof Error && error.message.startsWith('미설정:') ? error.message : '실행 실패: 설정, 모델 사용 권한 또는 입력을 확인하세요. 제공자 원문은 비밀 보호를 위해 출력하지 않습니다.');
  process.exitCode = 1;
}
