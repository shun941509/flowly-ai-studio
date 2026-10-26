/** Workers 환경 바인딩을 인증 설정으로 변환하는 플랫폼 경계. 순수 설정 검증 코드는 config.ts에 둔다. */
import { env } from "cloudflare:workers";
import { parseAuthConfig } from "./config";

export function getAuthConfig() {
  return parseAuthConfig(env as unknown as Record<string, unknown>);
}
