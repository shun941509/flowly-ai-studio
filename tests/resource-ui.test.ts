import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Resource } from "../app/lib/model";
import { ResourceForm, ResourceDetail } from "../app/ui/resources";
import { ResourceReadiness } from "../app/ui/resource-fields";
import { serializeMcpRegistration } from "../domain/mcp-registration";
import { getToolCandidate } from "../domain/tool-catalog";

const date="2026-10-27T00:00:00.000Z";
const resource=(type:Resource["type"],content:string):Resource=>({id:"material",ownerId:"owner",name:"자료",type,content,description:"등록한 자료",url:"",visibility:"public",allowedEmails:[],createdAt:date,updatedAt:date});
test("Python preset detail distinguishes executable settings from documents and reports actual source-audited scope",()=>{
 const tool=getToolCandidate("jsonl")!;
 const preset=resource("document",JSON.stringify({flowlyPython:{version:1,toolId:tool.id,arguments:tool.exampleArguments}}));
 const html=renderToStaticMarkup(createElement(ResourceReadiness,{resource:preset}));
 assert.match(html,/Python 도구 설정 자료 · flowlyPython/);assert.match(html,/등록된 실행 설정/);assert.match(html,/설치·실행 상태를 확인하지 않았습니다/);assert.match(html,/반환 항목/);
 const plain=renderToStaticMarkup(createElement(ResourceReadiness,{resource:resource("document","일반 문서")}));
 assert.doesNotMatch(plain,/Python 도구 설정 자료/);
 const invalid=renderToStaticMarkup(createElement(ResourceReadiness,{resource:resource("document",'{"flowlyPython":{"version":99}}')}));
 assert.match(invalid,/정의 확인이 필요/);
});

test("shared MCP detail exposes input/output targets, examples and recovery guidance without edit permission or live verification",()=>{
 const content=serializeMcpRegistration({version:1,connectionId:"internal",endpointEnv:"FLOWLY_MCP_ENDPOINT_INTERNAL",tools:[{name:"lookup",description:"업무 데이터 조회",effect:"read",targetDescription:"사내 색인의 공개 항목",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]},outputSchema:{type:"object",properties:{answer:{type:"string"}},required:["answer"]},outputTarget:"structuredContent",inputExample:{query:"요청"},outputExample:{answer:"예시"},errorExample:"색인 없음",nextAction:"자료 소유자에게 색인 상태 확인"}]});
 const html=renderToStaticMarkup(createElement(ResourceDetail,{resource:resource("mcp",content),user:{userId:"viewer",email:"viewer@example.test",displayName:"조회자"},onClose(){},onEdit(){},onDelete(){},onAdd(){},onCopy(){}}));
 for(const text of ["출력 계약","structuredContent","출력 예시 · 실제 실행 결과 아님","오류 시 다음 행동","사내 색인의 공개 항목","data.structuredContent.필드명"])assert.ok(html.includes(text),text);
 assert.match(html,/웹에서 연결하거나 도구를 호출하지 않았습니다/);assert.match(html,/내 자료로 복사/);assert.doesNotMatch(html,/변경 감사 이력/);
});

test("resource editing exposes user-reported verification scope and separate file application without claiming service checks",()=>{
 const html=renderToStaticMarkup(createElement(ResourceForm,{initial:{...resource("skill","지침"),details:{version:1,verification:{kind:"user_reported",checkedAt:date,environment:"검증 PC",scope:"로컬 계산 결과 확인",outcome:"passed"}}},onClose(){},onSave:async()=>{}}));
 for(const text of ["사용자 실행 확인 기록","확인 날짜","실행 환경","확인한 범위","직접 확인한 결과","검증 PC","로컬 계산 결과 확인"])assert.ok(html.includes(text),text);
 assert.match(html,/Flowly의 서비스 연결 확인이나 AI 품질 인증이 아니며/);
 assert.match(html,/웹에서는 서비스 연결이나 코드를 실행하지 않습니다/);
 assert.match(html,/파일당 5,000,000 바이트/);
});

