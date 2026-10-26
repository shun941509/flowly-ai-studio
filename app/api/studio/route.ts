/** 설계/자료 CRUD·공유·버전·미리보기 API. 인증/요청 형식을 확인하고 개별 권한·동시성 검사는 WorkflowHistoryRepository에 위임한다. */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { resources, runs, users } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";
import { canReadResource, parseDefinition, sampleResources, simulateFlow, uid, type Workflow } from "../../lib/model";
import { env } from "cloudflare:workers";
import { getAuthConfig } from "../../../server/auth/environment";
import { sameOriginMutation } from "../../../server/auth/session";
import { HistoryError, WorkflowHistoryRepository } from "../../../server/repositories/workflow-history";
import { decodeResource } from "../../../server/repositories/resources";
import { ResourceHistoryRepository } from "../../../server/repositories/resource-history";
import { RESOURCE_REQUEST_MAX_BYTES } from "../../../domain/resource-contract";
export const dynamic="force-dynamic";
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
async function accessible(user:{userId:string;email:string;displayName:string}){
  const db=getDb();
  const rows=await db.select().from(resources).where(or(eq(resources.ownerId,user.userId),eq(resources.visibility,"public"),and(eq(resources.visibility,"selected"),sql`EXISTS (SELECT 1 FROM json_each(${resources.allowedEmails}) WHERE value = ${user.email.toLowerCase()})`)));
  return [...sampleResources,...rows.map(decodeResource).filter(r=>canReadResource(r,user))];
}
/** 현재 세션 사용자에게 읽기 가능한 자료/설계와 본인의 미리보기 이력만 반환한다. */
export async function GET(){
  const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);
  try{
    if(!env.DB)return respond({error:"저장소 연결이 아직 설정되지 않았어요."},503);
    const db=getDb();await db.insert(users).values({id:user.userId,email:user.email.toLowerCase(),name:user.displayName,createdAt:new Date().toISOString()}).onConflictDoUpdate({target:users.id,set:{email:user.email.toLowerCase(),name:user.displayName}});
    const [r,w,h]=await Promise.all([accessible(user),new WorkflowHistoryRepository(env.DB).listWorkflows(user),db.select().from(runs).where(eq(runs.ownerId,user.userId)).orderBy(desc(runs.createdAt)).limit(50)]);
    return respond({resources:r.map(x=>({...x,allowedEmails:x.ownerId===user.userId?x.allowedEmails:[]})),workflows:w,runs:h.map(x=>({...x,steps:JSON.parse(x.steps)}))});
  }catch{console.error("Workspace read failed");return respond({error:"저장소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요."},500);}
}
/** 액션에 들어 있는 ownerId나 권한 플래그는 사용하지 않는다. 검증된 세션 Identity를 모든 저장소 작업에 전달한다. */
export async function POST(request:Request){
  const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);
  if(!sameOriginMutation(getAuthConfig(),request))return respond({error:"허용되지 않은 요청입니다."},403);
  if(!request.headers.get("content-type")?.includes("application/json"))return respond({error:"JSON 요청이 필요해요."},415);
  try{
    const raw=await request.text();if(new TextEncoder().encode(raw).length>RESOURCE_REQUEST_MAX_BYTES)return respond({error:"저장 요청은 4MB 이하여야 해요. 본문과 첨부 파일은 별도로 저장해 주세요."},413);
    const body=JSON.parse(raw);
    if(!body||typeof body!=="object"||Array.isArray(body))return respond({error:"요청 형식을 확인해 주세요."},400);
    if(!env.DB)return respond({error:"저장소 연결이 아직 설정되지 않았어요."},503);
    const db=getDb(),history=new WorkflowHistoryRepository(env.DB),now=new Date().toISOString();
    if(body.action==="resource.create")return respond({resource:await history.createResource(user,body.data)},201);
    if(body.action==="resource.update")return respond({resource:await history.updateResource(user,body.id,body.data,body.baseUpdatedAt)});
    if(body.action==="resource.delete"){await history.deleteResource(user,body.id);return respond({ok:true});}
    const resourceHistory=new ResourceHistoryRepository(env.DB);
    if(body.action==="resource.get"){const resource=await resourceHistory.get(user,body.id);return respond({resource:{...resource,allowedEmails:resource.ownerId===user.userId?resource.allowedEmails:[]}});}
    if(body.action==="resource.versions")return respond({versions:await resourceHistory.versions(user,body.id)});
    if(body.action==="resource.restore")return respond({resource:await resourceHistory.restore(user,body.id,body.versionId,body.baseUpdatedAt)});
    if(body.action==="resource.import")return respond({resource:await resourceHistory.import(user,body.sourceResourceId,body.baseUpdatedAt,body.mode,body.data)});
    if(body.action==="resource.impact")return respond(await resourceHistory.impact(user,body.id));
    if(body.action==="workflow.get")return respond({workflow:await history.getWorkflow(user,body.id)});
    if(body.action==="workflow.share")return respond({workflow:await history.shareWorkflow(user,body.id,body.data,body.baseUpdatedAt)});
    if(body.action==="workflow.import")return respond({workflow:await history.importWorkflow(user,body.data,body.mode,body.origin)});
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
    /** simulateFlow는 설계 미리보기다. 외부 모델/MCP를 호출하는 실제 실행이나 runtime_runs 체크포인트로 저장하지 않는다. */
    if(body.action==="preview.run"){
      const input=String(body.input||"").trim();if(!input||input.length>12000)throw new Error("테스트 입력을 1~12,000자로 입력해 주세요.");
      await history.checkExport(user,String(body.workflow?.id||"draft"));const definition=parseDefinition(body.workflow?.definition);const available=await accessible(user);
      const workflow:Workflow={id:String(body.workflow.id||"").slice(0,100),name:String(body.workflow.name||"워크플로").slice(0,80),description:"",definition,updatedAt:now};
      const run={...simulateFlow(workflow,input,available),id:uid("run"),createdAt:now};await db.insert(runs).values({...run,ownerId:user.userId,steps:JSON.stringify(run.steps)});return respond({run});
    }
    return respond({error:"지원하지 않는 작업이에요."},400);
  }catch(error){
    if(error instanceof HistoryError){const current=error.current&&"content" in error.current&&error.current.ownerId!==user.userId?{...error.current,allowedEmails:[]}:error.current;return respond({error:error.message,...(error.status===409?{conflict:true,current}: {})},error.status);}
    if(error instanceof SyntaxError)return respond({error:"요청 형식을 확인해 주세요."},400);
    const message=error instanceof Error?error.message:"요청을 처리하지 못했어요.";
    if(/SQLITE|D1_|Failed query|database/i.test(message)){console.error("Workspace write failed");return respond({error:"저장에 실패했어요. 입력 내용은 유지됩니다. 잠시 후 다시 시도해 주세요."},500);}
    return respond({error:message},400);
  }
}
