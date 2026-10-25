import type { Identity } from "../app/lib/model";
import { parseSchema } from "../domain/schema";
import { safeEndpoint } from "../runtime/adapters/http";
import type { RuntimeCapabilities, ToolDefinition } from "../runtime/types";
export type ServerEnvironment = Record<string, unknown>;
export type Connection = {id:string;ownerId:string;resourceId:string;name:string;endpoint:string;endpointEnv?:string;tokenEnv?:string;tools:ToolDefinition[]};
const testSchema = {type:"object" as const,properties:{query:{type:"string" as const}},required:["query"],additionalProperties:false};
export const testTools:ToolDefinition[] = [
  {resourceId:"sample-search",connectionId:"test-read",toolName:"lookup",name:"lookup",description:"입력을 확인하는 읽기 도구 · 외부 호출 없는 테스트",effect:"read",inputSchema:testSchema},
  {resourceId:"sample-search",connectionId:"test-write",toolName:"draft_note",name:"draft_note",description:"승인 동작을 확인하는 쓰기 도구 · 실제 저장하지 않는 테스트",effect:"write",inputSchema:testSchema},
];
export function testRuntimeEnabled(env:ServerEnvironment) {return ["development","test"].includes(String(env.FLOWLY_ENV)) && env.FLOWLY_AUTH_MODE==="test" && env.FLOWLY_TEST_RUNTIME==="true";}
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
      return {resourceId:c.resourceId,connectionId:c.id,toolName:t.toolName,name:t.name,description:String(t.description||""),effect:t.effect as "read"|"write",inputSchema:parseSchema(t.inputSchema),supportsIdempotency:false};
    });
    connections.push({id:c.id,ownerId:c.ownerId,resourceId:c.resourceId,name:c.name,endpoint,...(c.endpointEnv?{endpointEnv:c.endpointEnv}:{}),tokenEnv:c.tokenEnv,tools});
  }
  if(new Set(connections.map(c=>c.id)).size!==connections.length||new Set(connections.flatMap(c=>c.tools.map(t=>t.name))).size!==connections.flatMap(c=>c.tools).length)throw new Error("중복된 연결 또는 도구 이름이 있어요.");
  return connections;
}
export function runtimeCapabilities(user:Identity,env:ServerEnvironment):RuntimeCapabilities {
  void user;
  const testEnabled=testRuntimeEnabled(env);
  return {testEnabled,liveEnabled:false,liveReason:"웹에서는 OpenAI를 호출하지 않아요. 실행 프로젝트를 내보낸 뒤 본인의 API 키를 설정해 실행하세요.",connections:[
    ...(testEnabled?testTools.map(t=>({id:t.connectionId,resourceId:t.resourceId,name:t.description,status:"configured" as const,tools:[t]})):[]),
  ]};
}
// Export connection definitions only. Credentials belong to the recipient's local environment.
export function exportConnectionsFor(user:Identity,env:ServerEnvironment):Connection[] {
  // Current authorized resources are resolved by the export builder. Server
  // environment definitions and public MCP defaults are not export sources.
  void user; void env;
  return [];
}
export function requireCurrentTool(user:Identity,env:ServerEnvironment,mode:"test"|"live",tool:ToolDefinition) {
  const available=mode==="test"&&testRuntimeEnabled(env)?testTools:mode==="live"?connectionsFor(user,env).flatMap(c=>c.tools):[];
  const current=available.find(t=>t.connectionId===tool.connectionId&&t.resourceId===tool.resourceId&&t.toolName===tool.toolName&&t.name===tool.name);
  if(!current||current.effect!==tool.effect||JSON.stringify(current.inputSchema)!==JSON.stringify(tool.inputSchema))throw new Error("도구 연결 권한이나 정의가 변경되었어요. 설정을 확인하고 새 실행을 시작해 주세요.");
  if(mode==="live") {const c=connectionsFor(user,env).find(c=>c.id===tool.connectionId)!;if(c.tokenEnv&&!env[c.tokenEnv])throw new Error("연결 필요: 이 서비스의 자격 증명이 설정되지 않았어요.");}
}
