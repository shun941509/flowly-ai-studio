import { env } from "cloudflare:workers";
import { D1TestResourceFileStore, R2ResourceFileStore, ResourceFilesRepository } from "./resource-files";
import { HistoryError } from "./repositories/errors";
/** 운영은 R2를 요구한다. 명시적인 개발/테스트 인증 환경에서만 D1 첨부 어댑터를 선택한다. */
export function resourceFilesForEnvironment(){
  if(!env.DB)throw new HistoryError("자료 저장소가 미설정이에요.",503);
  const settings=env as unknown as Record<string,unknown>;
  const store=env.BUCKET?new R2ResourceFileStore(env.BUCKET):settings.FLOWLY_FILE_STORAGE==="d1-test"&&["development","test"].includes(String(settings.FLOWLY_ENV))&&settings.FLOWLY_AUTH_MODE==="test"?new D1TestResourceFileStore(env.DB):undefined;
  return new ResourceFilesRepository(env.DB,store);
}
