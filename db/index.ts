/** Workers D1 바인딩을 Drizzle에 연결하는 저장 어댑터. DB가 없으면 메모리 저장으로 대체하지 않고 미설정 오류를 낸다. */
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
