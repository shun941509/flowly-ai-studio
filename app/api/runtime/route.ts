/** 웹 테스트 실행 API. 사용자별 실행 저장소를 사용하며 live 실행은 capabilities에서 차단한다. 실제 서비스 실행은 내보낸 실행기의 영역이다. */
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { compileDefinition, referencedResourceIds } from "../../../domain/workflow";
import { allNodes } from "../../../domain/advanced-config";
import { createRun, publicRun } from "../../../runtime/engine";
import { processRun, recordApproval, recordReview, recordInput, repository } from "../../../server/runtime-service";
import { runtimeCapabilities, requireCurrentTool, connectionsFor, testTools, type ServerEnvironment } from "../../../server/connections";
import { accessibleResources, requireResources } from "../../../server/repositories/resources";
import { schedule } from "../../../server/execution-context";
import { getDb } from "../../../db";
import { users } from "../../../db/schema";
import { hashRequest } from "../../../server/request-hash";
import { registeredConnections } from "../../../server/example-connections";
export const dynamic="force-dynamic";
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
/** 저장된 본인 실행 또는 설정 가능 도구 목록을 반환한다. 등록 MCP 표시는 연결 성공이 아니므로 unconfigured로 제공한다. */
export async function GET(request:Request) {
  const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);
  try {
    const id=new URL(request.url).searchParams.get("id");
    if(id) {const run=await repository().get(user.userId,id);return run?respond({run:publicRun(run)}):respond({error:"실행을 찾을 수 없어요."},404);}
    const resources=await accessibleResources(user),ids=new Set(resources.map(r=>r.id));
    const capabilities=runtimeCapabilities(user,env as unknown as ServerEnvironment);
    capabilities.connections=registeredConnections(user,resources).filter(c=>ids.has(c.resourceId)).map(c=>({id:c.id,resourceId:c.resourceId,name:c.name,status:"unconfigured" as const,tools:c.tools}));
    return respond({capabilities,runs:(await repository().list(user.userId)).map(publicRun)});
  } catch {return respond({error:"실행 저장소 또는 연결 설정을 확인해 주세요."},503);}
}
/** 세션·요청 형식을 검사하고 시작/취소/승인/보완 입력을 지속 저장 계층에 전달한다. 실행 ID만으로 다른 사용자 상태를 변경하지 않는다. */
export async function POST(request:Request) {
  const user=await getChatGPTUser();if(!user)return respond({error:"로그인 후 이용해 주세요."},401);
  const origin=request.headers.get("origin");
  if((origin&&origin!==new URL(request.url).origin)||request.headers.get("sec-fetch-site")==="cross-site")return respond({error:"허용되지 않은 요청이에요."},403);
  if(!request.headers.get("content-type")?.includes("application/json"))return respond({error:"JSON 요청이 필요해요."},415);
  try {
    const raw=await request.text();if(raw.length>350000)return respond({error:"입력 내용이 너무 커요."},413);
    const body=JSON.parse(raw),config=env as unknown as ServerEnvironment;
    if(body.action==="run.start") {
      if(!["test","live"].includes(body.mode))throw new Error("테스트 또는 실제 실행을 선택해 주세요.");
      const caps=runtimeCapabilities(user,config);
      if(body.mode==="test"&&!caps.testEnabled)return respond({error:"테스트 실행은 로컬 테스트 로그인에서만 사용할 수 있어요."},403);
      if(body.mode==="live"&&!caps.liveEnabled)return respond({error:caps.liveReason},409);
      const key=String(body.idempotencyKey||"");if(!/^[A-Za-z0-9_-]{8,100}$/.test(key))throw new Error("실행 요청 키가 올바르지 않아요.");
      const input=String(body.input||"").trim();if(!input||input.length>12000)throw new Error("입력은 1~12,000자로 작성해 주세요.");
      const definition=compileDefinition(body.workflow?.definition);
      const resources=await requireResources(user,referencedResourceIds(definition));
      const tools=body.mode==="test"?testTools:connectionsFor(user,config).flatMap(c=>c.tools);
      for(const node of allNodes(definition))for(const chosen of node.allowedTools||[]) {
        const tool=tools.find(t=>t.connectionId===chosen.connectionId&&t.resourceId===chosen.resourceId&&t.toolName===chosen.toolName);
        if(!tool)return respond({error:"허용된 본인 서비스 연결을 선택해 주세요."},403);
        requireCurrentTool(user,config,body.mode,tool);
        if(resources.find(r=>r.id===chosen.resourceId)?.type!=="mcp")throw new Error("도구는 MCP 자료에 연결해 주세요.");
      }
      const now=new Date().toISOString();
      const workflow={id:String(body.workflow?.id||"").slice(0,100),name:String(body.workflow?.name||"워크플로").slice(0,80),description:String(body.workflow?.description||"").slice(0,300),definition,updatedAt:now};
      await getDb().insert(users).values({id:user.userId,email:user.email.toLowerCase(),name:user.displayName,createdAt:now}).onConflictDoUpdate({target:users.id,set:{email:user.email.toLowerCase(),name:user.displayName}});
      /** 같은 요청 키라도 입력·설계·모드가 달라지면 재사용을 거절하도록 요청 의미를 함께 해시한다. */
      const hash=await hashRequest({mode:body.mode,input,definition,workflowId:workflow.id});
      const run=await repository().create(createRun({owner:user,mode:body.mode,workflow,resources,input}),key,hash);
      if(run.mode==="test")schedule(processRun(user.userId,run.id));
      return respond({run:publicRun(run)},202);
    }
    const id=String(body.id||"");const run=await repository().get(user.userId,id);
    if(!run)return respond({error:"실행을 찾을 수 없어요."},404);
    if(body.action==="run.cancel") {await repository().cancel(user.userId,id);if(run.mode==="test")schedule(processRun(user.userId,id));}
    else if(body.action==="run.resume") {if(run.mode==="test")schedule(processRun(user.userId,id));}
    else if(body.action==="approval.decide") {
      if(!["approve","deny"].includes(body.decision))throw new Error("승인 또는 거절을 선택해 주세요.");
      const approval=publicRun(run).approvals.find(a=>a.id===body.approvalId&&a.userId===user.userId);
      if(!approval)return respond({error:"승인 요청을 찾을 수 없어요."},404);
      if(approval.status!=="pending")return respond({run:publicRun(run)});
      const updated=await recordApproval(user.userId,id,approval.id,body.decision==="approve"?"approved":"denied");
      if(run.mode==="test")schedule(processRun(user.userId,id));
      return respond({run:publicRun(updated)},202);
    } else if(body.action==="review.decide") {
      if(!["accept","reject"].includes(body.decision))throw new Error("검토의 수락 또는 거절을 선택해 주세요.");
      const review=publicRun(run).reviews?.find(r=>r.id===body.reviewId&&r.userId===user.userId);
      if(!review)return respond({error:"검토 요청을 찾을 수 없어요."},404);
      const updated=await recordReview(user.userId,id,review.id,body.decision==="accept"?"accepted":"rejected",body.editedInput);
      return respond({run:publicRun(updated)},202);
    } else if(body.action==="input.submit") {
      const inputRequest=publicRun(run).inputRequests?.find(r=>r.id===body.requestId&&r.userId===user.userId);
      if(!inputRequest)return respond({error:"입력 요청을 찾을 수 없어요."},404);
      const updated=await recordInput(user,id,inputRequest.id,body.values);
      return respond({run:publicRun(updated)},202);
    } else throw new Error("지원하지 않는 작업이에요.");
    return respond({run:publicRun((await repository().get(user.userId,id))!)},202);
  } catch(error) {
    const message=error instanceof Error?error.message:"요청을 처리하지 못했어요.";
    if(/SQLITE|D1_|Failed query|database/i.test(message))return respond({error:"실행 저장에 실패했어요. 잠시 후 다시 시도해 주세요."},503);
    return respond({error:error instanceof SyntaxError?"요청 형식을 확인해 주세요.":message},400);
  }
}
