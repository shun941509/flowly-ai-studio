/**
 * 기존 .dev.vars를 보존하면서 파일이 없을 때만 로컬 테스트 로그인 설정을 만든다. 운영 SSO나 실제 모델/MCP를 연결하는 설정 절차는 아니다.
 */
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const path = new URL("../.dev.vars", import.meta.url);
if (existsSync(path)) console.log(".dev.vars가 이미 있어 기존 설정을 유지합니다.");
else {
  writeFileSync(path, `FLOWLY_ENV=development\nFLOWLY_AUTH_MODE=test\nFLOWLY_APP_ORIGIN=http://127.0.0.1:5173\nFLOWLY_SESSION_SECRET=${randomBytes(48).toString("base64url")}\nFLOWLY_TEST_RUNTIME=true\n`, {mode:0o600});
  console.log("로컬 테스트 로그인 설정을 .dev.vars에 저장했습니다. 실제 SSO·모델·MCP는 연결하지 않았습니다.");
}
