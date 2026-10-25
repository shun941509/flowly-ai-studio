import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { resources, workflows, runs, users } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";
import { canReadResource, parseDefinition, sampleResources, simulateFlow, uid, type Resource, type Workflow } from "../../lib/model";
import { env } from "cloudflare:workers";
import { getAuthConfig } from "../../../server/auth/environment";
import { sameOriginMutation } from "../../../server/auth/session";
import { HistoryError, WorkflowHistoryRepository } from "../../../server/repositories/workflow-history";
export const dynamic="force-dynamic";
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
function decodeResource(r:typeof resources.$inferSelect): Resource { return {...r,type:r.type as Resource["type"],visibility:r.visibility as Resource["visibility"],allowedEmails:JSON.parse(r.allowedEmails)}; }
async function accessible(user:{userId:string;email:string;displayName:string}){
  const db=getDb();
  const rows=await db.select().from(resources).where(or(eq(resources.ownerId,user.userId),eq(resources.visibility,"public"),and(eq(resources.visibility,"selected"),sql`EXISTS (SELECT 1 FROM json_each(${resources.allowedEmails}) WHERE value = ${user.email.toLowerCase()})`)));
  return [...sampleResources,...rows.map(decodeResource).filter(r=>canReadResource(r,user))];
}
export async function GET(){
  const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);
  try{
    const db=getDb();await db.insert(users).values({id:user.userId,email:user.email.toLowerCase(),name:user.displayName,createdAt:new Date().toISOString()}).onConflictDoUpdate({target:users.id,set:{email:user.email.toLowerCase(),name:user.displayName}});
    const [r,w,h]=await Promise.all([accessible(user),db.select().from(workflows).where(eq(workflows.ownerId,user.userId)).orderBy(desc(workflows.updatedAt)),db.select().from(runs).where(eq(runs.ownerId,user.userId)).orderBy(desc(runs.createdAt)).limit(50)]);
    return respond({resources:r.map(x=>({...x,allowedEmails:x.ownerId===user.userId?x.allowedEmails:[]})),workflows:w.map(x=>({...x,definition:JSON.parse(x.definition)})),runs:h.map(x=>({...x,steps:JSON.parse(x.steps)}))});
  }catch{console.error("Workspace read failed");return respond({error:"저장소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요."},500);}
}
export async function POST(request:Request){
  const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);
  if(!sameOriginMutation(getAuthConfig(),request))return respond({error:"허용되지 않은 요청입니다."},403);
  if(!request.headers.get("content-type")?.includes("application/json"))return respond({error:"JSON 요청이 필요해요."},415);
  try{
    const raw=await request.text();if(new TextEncoder().encode(raw).length>350000)return respond({error:"저장할 내용이 너무 커요."},413);
    const body=JSON.parse(raw);
    if(!body||typeof body!=="object"||Array.isArray(body))return respond({error:"요청 형식을 확인해 주세요."},400);
    if(!env.DB)return respond({error:"저장소 연결이 아직 설정되지 않았어요."},503);
    const db=getDb(),history=new WorkflowHistoryRepository(env.DB),now=new Date().toISOString();
    if(body.action==="resource.create")return respond({resource:await history.createResource(user,body.data)},201);
    if(body.action==="resource.update")return respond({resource:await history.updateResource(user,body.id,body.data,body.baseUpdatedAt)});
    if(body.action==="resource.delete"){await history.deleteResource(user,body.id);return respond({ok:true});}
    if(body.action==="workflow.save")return respond({workflow:await history.saveWorkflow(user,body.data,body.baseUpdatedAt)});
    if(body.action==="workflow.delete"){await history.deleteWorkflow(user,body.id);return respond({ok:true});}
    if(body.action==="workflow.publish")return respond({version:await history.publish(user,body.id,body.baseUpdatedAt)});
    if(body.action==="workflow.versions")return respond({versions:await history.versions(user,body.id)});
    if(body.action==="workflow.version")return respond({version:await history.getVersion(user,body.id,body.versionId)});
    if(body.action==="workflow.diff")return respond({diff:await history.diff(user,body.id,body.fromVersionId,body.toVersionId)});
    if(body.action==="workflow.restore")return respond({workflow:await history.restore(user,body.id,body.versionId,body.baseUpdatedAt)});
    if(body.action==="resource.comments")return respond({comments:await history.comments(user,body.id)});
    if(body.action==="comment.create")return respond({comment:await history.createComment(user,body.id,body.text)});
    if(body.action==="comment.delete"){await history.deleteComment(user,body.id,body.commentId);return respond({ok:true});}
    if(body.action==="audit.list"){
      if((body.targetType!==undefined&&!["workflow","resource"].includes(body.targetType))||Boolean(body.targetType)!==Boolean(body.id))throw new HistoryError("감사 기록 대상을 확인해 주세요.");
      return respond({events:await history.audits(user,body.targetType,body.id)});
    }
    if(body.action==="preview.run"){
      const input=String(body.input||"").trim();if(!input||input.length>12000)throw new Error("테스트 입력을 1~12,000자로 입력해 주세요.");
      const definition=parseDefinition(body.workflow?.definition);const available=await accessible(user);
      const workflow:Workflow={id:String(body.workflow.id||"").slice(0,100),name:String(body.workflow.name||"워크플로").slice(0,80),description:"",definition,updatedAt:now};
      const run={...simulateFlow(workflow,input,available),id:uid("run"),createdAt:now};await db.insert(runs).values({...run,ownerId:user.userId,steps:JSON.stringify(run.steps)});return respond({run});
    }
    return respond({error:"지원하지 않는 작업이에요."},400);
  }catch(error){
    if(error instanceof HistoryError)return respond({error:error.message,...(error.status===409?{conflict:true,current:error.current}: {})},error.status);
    if(error instanceof SyntaxError)return respond({error:"요청 형식을 확인해 주세요."},400);
    const message=error instanceof Error?error.message:"요청을 처리하지 못했어요.";
    if(/SQLITE|D1_|Failed query|database/i.test(message)){console.error("Workspace write failed");return respond({error:"저장에 실패했어요. 입력 내용은 유지됩니다. 잠시 후 다시 시도해 주세요."},500);}
    return respond({error:message},400);
  }
}
