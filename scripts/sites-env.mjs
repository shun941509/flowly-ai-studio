/**
 * 독립 Wrangler 명령도 같은 프로젝트 경로와 도구 기본 설정을 쓰도록 준비한다. 불러오는 시점에 작업 디렉터리와 로컬 도구 폴더를 설정한다.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureToolEnvironment } from "./tool-environment.mjs";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
configureToolEnvironment(projectRoot);

process.chdir(projectRoot);
for (const directory of [
  path.dirname(process.env.WRANGLER_LOG_PATH),
  process.env.WRANGLER_REGISTRY_PATH,
  process.env.MINIFLARE_REGISTRY_PATH,
]) {
  mkdirSync(directory, { recursive: true });
}
