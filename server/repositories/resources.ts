import { and, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { resources } from "../../db/schema";
import { canReadResource, sampleResources, type Resource, type Identity } from "../../app/lib/model";

export function decodeResource(row:typeof resources.$inferSelect):Resource {
  return {...row,type:row.type as Resource["type"],visibility:row.visibility as Resource["visibility"],allowedEmails:JSON.parse(row.allowedEmails)};
}
export async function accessibleResources(user:Identity):Promise<Resource[]> {
  const rows = await getDb().select().from(resources).where(or(eq(resources.ownerId,user.userId),eq(resources.visibility,"public"),and(eq(resources.visibility,"selected"),sql`EXISTS (SELECT 1 FROM json_each(${resources.allowedEmails}) WHERE value = ${user.email.toLowerCase()})`)));
  return [...sampleResources,...rows.map(decodeResource).filter(r=>canReadResource(r,user))];
}
export async function requireResources(user:Identity, ids:string[]):Promise<Resource[]> {
  const available = await accessibleResources(user);
  return ids.map(id=>{const resource=available.find(r=>r.id===id);if(!resource)throw new Error("접근 권한이 없거나 공유가 철회된 자료예요. 자료 소유자에게 확인해 주세요.");return resource;});
}
