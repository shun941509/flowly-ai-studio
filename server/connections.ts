/** 서버 연결 정의와 웹 실행 가능 범위를 분리한다. 실제 모델 실행은 내보낸 환경에서 수행하며 웹 live 실행은 비활성이다. */
import type { Identity } from "../app/lib/model";
import { parseSchema } from "../domain/schema";
import { safeEndpoint } from "../runtime/adapters/http";
import type { RuntimeCapabilities, ToolDefinition } from "../runtime/types";
export type ServerEnvironment = Record<string, unknown>;
export type Connection = {id:string;ownerId:string;resourceId:string;name:string;endpoint:string;endpointEnv?:string;tokenEnv?:string;tools:ToolDefinition[]};
const testSchema = {type:"object" as const,properties:{query:{type:"string" as const}},required:["query"],additionalProperties:false};
/** 명시적 로컬 테스트 런타임 전용 도구 계약. 실제 MCP 서비스 연결이나 업무 성공 결과를 뜻하지 않는다. */
export const testTools:ToolDefinition[] = [
  {resourceId:"sample-search",connectionId:"test-read",toolName:"lookup",name:"lookup",description:"입력을 확인하는 읽기 도구 · 외부 호출 없는 테스트",effect:"read",inputSchema:testSchema},
  {resourceId:"sample-search",connectionId:"test-write",toolName:"draft_note",name:"draft_note",description:"승인 동작을 확인하는 쓰기 도구 · 실제 저장하지 않는 테스트",effect:"write",inputSchema:testSchema},
];
/** 환경·인증 방식·테스트 실행 플래그가 모두 맞아야 테스트 대역을 노출한다. */
export function testRuntimeEnabled(env:ServerEnvironment) {return ["development","test"].includes(String(env.FLOWLY_ENV)) && env.FLOWLY_AUTH_MODE==="test" && env.FLOWLY_TEST_RUNTIME==="true";}
/** 서버 설정에서 현재 사용자 소유 연결만 파싱한다. 이 함수가 연결을 반환해도 웹 live 실행을 허용하지는 않는다. */
export function connectionsFor(user:Identity,env:ServerEnvironment):Connection[] {
  let raw:unknown;
  try {raw=JSON.parse(String(env.FLOWLY_CONNECTIONS_JSON||"[]"));}catch{throw new Error("연결 설정을 읽지 못했어요. 관리자에게 확인해 주세요.");}
  if(!Array.isArray(raw)||raw.length>100)throw new Error("연결 설정 형식이 올바르지 않아요.");
  const connections:Connection[]=[];
  for(const c of raw) {
    if(c.ownerId!==user.userId)continue;
    if([c.id,c.resourceId,c.name,c.endpoint].some(x=>typeof x!=="string"||!x)||!Array.isArray(c.tools))throw new Error("연결 설정이 불완전해요.");
    if(c.id==="local-python" || c.resourceId==="local-python")throw new Error("Python 도구 전용 연결 ID는 MCP에 사용할 수 없어요.");
    const endpoint=safeEndpoint(c.endpoint);
    if(c.endpointEnv && !/^FLOWLY_MCP_ENDPOINT_[A-Z0-9_]+$/.test(c.endpointEnv))throw new Error("서비스 주소 설정 이름을 확인해 주세요.");
    if(c.tokenEnv && !/^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/.test(c.tokenEnv))throw new Error("연결 비밀 설정 이름을 확인해 주세요.");
    const tools:ToolDefinition[]=c.tools.map((t:Record<string,unknown>)=>{
      if(typeof t.toolName!=="string"||typeof t.name!=="string"||!(/^[A-Za-z0-9_-]{1,64}$/).test(t.name)||!["read","write"].includes(String(t.effect)))throw new Error("도구 이름과 변경 정책을 확인해 주세요.");
      if(t.outputTarget!==undefined&&!['structuredContent','result'].includes(String(t.outputTarget)))throw new Error("MCP 출력 검사 대상을 확인해 주세요.");
      return {resourceId:c.resourceId,connectionId:c.id,toolName:t.toolName,name:t.name,description:String(t.description||""),effect:t.effect as "read"|"write",inputSchema:parseSchema(t.inputSchema),...(t.outputSchema!==undefined?{outputSchema:parseSchema(t.outputSchema),outputTarget:(t.outputTarget??'structuredContent') as 'structuredContent'|'result'}:{}),supportsIdempotency:false};
    });
    connections.push({id:c.id,ownerId:c.ownerId,resourceId:c.resourceId,name:c.name,endpoint,...(c.endpointEnv?{endpointEnv:c.endpointEnv}:{}),tokenEnv:c.tokenEnv,tools});
  }
  if(new Set(connections.map(c=>c.id)).size!==connections.length||new Set(connections.flatMap(c=>c.tools.map(t=>t.name))).size!==connections.flatMap(c=>c.tools).length)throw new Error("중복된 연결 또는 도구 이름이 있어요.");
  return connections;
}
/** 화면이 표시할 지원 상태. liveEnabled=false를 유지해 웹에서 실제 모델을 실행하지 않도록 한다. */
export function runtimeCapabilities(user:Identity,env:ServerEnvironment):RuntimeCapabilities {
  void user;
  const testEnabled=testRuntimeEnabled(env);
  return {testEnabled,liveEnabled:false,liveReason:"웹에서는 OpenAI를 호출하지 않아요. 실행 프로젝트를 내보낸 뒤 본인의 API 키를 설정해 실행하세요.",connections:[
    ...(testEnabled?testTools.map(t=>({id:t.connectionId,resourceId:t.resourceId,name:t.description,status:"configured" as const,tools:[t]})):[]),
  ]};
}
// Export connection definitions only. Credentials belong to the recipient's local environment.
/** 웹 내보내기는 서버 환경의 연결을 복사하지 않는다. 현재 접근 가능한 MCP 등록 자료를 export-package에서 해석한다. */
export function exportConnectionsFor(user:Identity,env:ServerEnvironment):Connection[] {
  // Current authorized resources are resolved by the export builder. Server
  // environment definitions and public MCP defaults are not export sources.
  void user; void env;
  return [];
}
/** 도구 호출 직전에 연결·자료·도구 식별자와 효과/입력 계약을 현재 등록값과 대조한다. */
export function requireCurrentTool(user:Identity,env:ServerEnvironment,mode:"test"|"live",tool:ToolDefinition) {
  const available=mode==="test"&&testRuntimeEnabled(env)?testTools:mode==="live"?connectionsFor(user,env).flatMap(c=>c.tools):[];
  const current=available.find(t=>t.connectionId===tool.connectionId&&t.resourceId===tool.resourceId&&t.toolName===tool.toolName&&t.name===tool.name);
  if(!current||current.effect!==tool.effect||JSON.stringify(current.inputSchema)!==JSON.stringify(tool.inputSchema)||JSON.stringify(current.outputSchema)!==JSON.stringify(tool.outputSchema)||current.outputTarget!==tool.outputTarget)throw new Error("도구 연결 권한이나 정의가 변경되었어요. 설정을 확인하고 새 실행을 시작해 주세요.");
  if(mode==="live") {const c=connectionsFor(user,env).find(c=>c.id===tool.connectionId)!;if(c.tokenEnv&&!env[c.tokenEnv])throw new Error("연결 필요: 이 서비스의 자격 증명이 설정되지 않았어요.");}
}
