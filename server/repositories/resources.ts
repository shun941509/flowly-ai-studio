/** 자료 조회의 서버 권한 경계. 소유·전체 공개·지정 이메일 조건을 적용하며 워크플로 공유 권한으로 자료 접근을 대신하지 않는다. */
import { and, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { resources } from "../../db/schema";
import { canReadResource, sampleResources, type Resource, type Identity } from "../../app/lib/model";

export function decodeResource(row:typeof resources.$inferSelect):Resource {
  const { details, files, writeToken: _writeToken, ...plain }=row; void _writeToken;
  return {...plain,type:row.type as Resource["type"],visibility:row.visibility as Resource["visibility"],allowedEmails:JSON.parse(row.allowedEmails),...(details&&details!=="null"?{details:JSON.parse(details)}:{}),...(files&&files!=="[]"?{files:JSON.parse(files)}:{})};
}
/** 현재 DB 공유 상태와 공통 샘플을 합쳐 읽기 가능한 자료를 반환한다. 읽기 가능은 원본 수정/삭제 권한을 의미하지 않는다. */
export async function accessibleResources(user:Identity):Promise<Resource[]> {
  const rows = await getDb().select().from(resources).where(or(eq(resources.ownerId,user.userId),eq(resources.visibility,"public"),and(eq(resources.visibility,"selected"),sql`EXISTS (SELECT 1 FROM json_each(${resources.allowedEmails}) WHERE value = ${user.email.toLowerCase()})`)));
  return [...sampleResources,...rows.map(decodeResource).filter(r=>canReadResource(r,user))];
}
/** 요청한 모든 ID를 현재 접근 가능한 자료에서 다시 찾는다. 누락·삭제·공유 철회를 같은 접근 실패로 처리한다. */
export async function requireResources(user:Identity, ids:string[]):Promise<Resource[]> {
  const available = await accessibleResources(user);
  return ids.map(id=>{const resource=available.find(r=>r.id===id);if(!resource)throw new Error("접근 권한이 없거나 공유가 철회된 자료예요. 자료 소유자에게 확인해 주세요.");return resource;});
}
