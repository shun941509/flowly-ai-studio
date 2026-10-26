/** 저장된 실행을 잠금 아래 진행하는 웹 서비스 계층. 웹에서는 명시적으로 허용한 테스트 대역만 실행하고 live 요청은 거절한다. */
import { env } from "cloudflare:workers";
import { RuntimeRepository } from "./repositories/runtime";
import { requireResources } from "./repositories/resources";
import { requireCurrentTool, testRuntimeEnabled, testTools, type ServerEnvironment } from "./connections";
import { executeRun, decideApproval, decideReview, submitInput } from "../runtime/engine";
import { runTree } from "../runtime/advanced";
import { TestModelAdapter, createTestToolCaller } from "../runtime/adapters";
import { referencedResourceIds } from "../domain/workflow";
import type { Identity } from "../app/lib/model";
import type { Json, RuntimeRun } from "../runtime/types";

function serviceFailure(run:RuntimeRun,status:"failed"|"unknown_outcome",message:string) {
  run.status=status;run.error=message;run.updatedAt=new Date().toISOString();
  run.events.push({sequence:(run.events.at(-1)?.sequence??0)+1,at:run.updatedAt,type:status,message});
}

/** 실행/승인 대기를 D1에 지속 저장한다. 바인딩 미설정 시 프로세스 메모리로 우회하지 않는다. */
export function repository() {if(!env.DB)throw new Error("저장소 연결 필요: D1을 설정해 주세요.");return new RuntimeRepository(env.DB);}
/** 현재 자료 권한을 재검사하고 승인/거절 결정만 저장한다. 실제 도구 호출은 이후 processRun 재개 단계의 책임이다. */
export async function recordApproval(ownerId:string,id:string,approvalId:string,decision:"approved"|"denied") {
  const lease=await repository().claim(ownerId,id,true);
  if(!lease)throw new Error("다른 실행 작업을 처리하고 있어요. 잠시 후 승인 상태를 확인하고 다시 시도해 주세요.");
  try {
    const current=await env.DB!.prepare("SELECT email,name FROM users WHERE id=?").bind(ownerId).first<{email:string;name:string}>();
    if(!current)throw new Error("로그인 정보를 확인할 수 없어요.");
    const user={userId:ownerId,email:current.email,displayName:current.name};
    try {await requireResources(user,referencedResourceIds(lease.run.workflow.definition));}
    catch {serviceFailure(lease.run,"failed","공유가 철회되었거나 자료 접근 권한이 없어 승인 작업을 중단했어요.");await lease.save(lease.run);return lease.run;}
    await decideApproval(lease.run,approvalId,ownerId,decision);
    await lease.save(lease.run); // Acknowledgement only after durable queued decision.
    return lease.run;
  } finally {await lease.release();}
}
/** lease를 획득한 한 작업자만 상태를 저장한다. 재개와 도구 호출 직전에 접근 권한을 다시 확인한다. */
export async function processRun(ownerId:string,id:string) {
  const repo=repository(),lease=await repo.claim(ownerId,id,true);
  if(!lease)return;
  const run=lease.run, config=env as unknown as ServerEnvironment;
  try {
    // The owner comes from the persisted, authenticated creation request.
    // Check latest verified identity record for selected-email sharing.
    const current=await env.DB!.prepare("SELECT email,name FROM users WHERE id=?").bind(ownerId).first<{email:string;name:string}>();
    if(!current)throw new Error("로그인 정보를 확인할 수 없어요. 다시 로그인해 주세요.");
    const user:Identity={userId:ownerId,email:current.email,displayName:current.name};
    await requireResources(user,referencedResourceIds(run.workflow.definition));
    if(run.mode==="test"&&!testRuntimeEnabled(config))throw new Error("테스트 실행이 비활성화되어 있어요.");
    if(run.mode==="live")throw new Error("실행 설정 변경: 웹에서는 OpenAI를 호출하지 않아요. 실행 프로젝트를 내보내 주세요.");
    // 실제 모델/도구 어댑터를 주입하는 지점이 아니다. 아래 대역은 명시적 테스트 실행 기록으로만 사용한다.
    await executeRun(run,{
      model:new TestModelAdapter(),
      tools:testTools,
      save:lease.save, isCancelled:lease.isCancelled,
      assertAccess:async(ids,tool)=>{await requireResources(user,ids);if(tool)requireCurrentTool(user,config,run.mode,tool);},
      callTool:createTestToolCaller(),
    });
  } catch(error) {
    // Adapter errors are deliberately generic; no upstream bodies or secret config.
    // 전송 중이던 쓰기는 실패로 단정하면 재개 때 중복 부작용이 생길 수 있다. 하위 실행까지 찾아 unknown_outcome으로 남긴다.
    const ambiguous=runTree(run).some(current=>current.checkpoint.calls.some(call=>call.tool.effect==="write"&&["dispatching","unknown_outcome"].includes(call.status)));
    serviceFailure(run,ambiguous?"unknown_outcome":"failed",ambiguous?"외부 변경 결과를 확인할 수 없어요. 연결된 서비스에서 결과를 확인해 주세요. 자동 재실행하지 않아요.":error instanceof Error && /권한|공유|연결|설정|로그인|승인|만료|테스트/.test(error.message)?error.message:"실행을 처리하지 못했어요. 실행 기록을 확인해 주세요.");
    try {await lease.save(run);} catch {/* A lost lease must never overwrite its replacement. */}
  } finally {await lease.release();}
}
/** 사람 검토의 수락/거절과 보완 내용을 저장한다. 외부 도구 쓰기 승인과는 별개인 검토 계약을 사용한다. */
export async function recordReview(ownerId: string, id: string, reviewId: string, decision: "accepted" | "rejected", edited?: Record<string, Json>) {
  const lease = await repository().claim(ownerId, id, true);
  if (!lease) throw new Error("다른 작업을 처리하고 있어요. 잠시 후 다시 시도해 주세요.");
  try {
    const current = await env.DB!.prepare("SELECT email,name FROM users WHERE id=?").bind(ownerId).first<{ email: string; name: string }>();
    if (!current) throw new Error("로그인 정보를 확인할 수 없어요.");
    try { await requireResources({ userId: ownerId, email: current.email, displayName: current.name }, referencedResourceIds(lease.run.workflow.definition)); }
    catch { serviceFailure(lease.run, "failed", "공유가 철회되었거나 자료 접근 권한이 없어 검토 작업을 중단했어요."); await lease.save(lease.run); return lease.run; }
    await decideReview(lease.run, reviewId, ownerId, decision, edited);
    await lease.save(lease.run);
    return lease.run;
  } finally { await lease.release(); }
}
/** 현재 로그인 사용자와 자료 권한을 확인한 뒤 대기 중인 보완 입력을 저장한다. 저장 자체는 실행 재개가 아니다. */
export async function recordInput(user: Identity, id: string, requestId: string, values: Record<string, Json>) {
  const lease = await repository().claim(user.userId, id, true);
  if (!lease) throw new Error("다른 작업을 처리하고 있어요. 잠시 후 다시 시도해 주세요.");
  try {
    // Use the identity verified for this request, including its current email.
    try { await requireResources(user, referencedResourceIds(lease.run.workflow.definition)); }
    catch { serviceFailure(lease.run, "failed", "공유가 철회되었거나 자료 접근 권한이 없어 보완 입력을 중단했어요."); await lease.save(lease.run); return lease.run; }
    await submitInput(lease.run, requestId, user.userId, values);
    await lease.save(lease.run);
    return lease.run;
  } finally { await lease.release(); }
}
/** 저장소가 선정한 소량의 만료/중단 실행을 차례로 처리한다. 복구 대상과 중복 방지는 repository의 lease 조건을 따른다. */
export async function recoverRuns() {for(const row of await repository().recoverable())await processRun(row.owner_id,row.id);}
