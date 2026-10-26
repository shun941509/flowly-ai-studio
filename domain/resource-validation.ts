/** 웹 저장·복구·외부 수정본에 동일한 자료 계약을 적용한다. 파일 소유권과 바이트 해시는 서버 저장소가 별도로 확인한다. */
import { assertSchema, parseSchema, safeField } from "./schema";
import { safeDataPath, validateJson } from "./node-config";
import type { Json } from "../runtime/types";
import { RESOURCE_CONTENT_MAX_CHARS, RESOURCE_METADATA_MAX_BYTES, RESOURCE_FILE_MAX_BYTES, RESOURCE_FILES_MAX_BYTES, RESOURCE_FILES_MAX_COUNT, type ResourceAttachment, type ResourceDetails, type ResourceNodeConfig } from "./resource-contract";

const own = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(key => !keys.includes(key))) throw new Error("지원하지 않는 자료 설정이나 필드가 있어요.");
  return v as Record<string, unknown>;
};
const text = (v: unknown, max: number, empty = true) => {
  if (typeof v !== "string" || v.length > max || !empty && !v.trim()) throw new Error(`자료 설정의 글자는 ${max}자 이내로 입력해 주세요.`);
  return v;
};
const integer = (v: unknown, min: number, max: number) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`숫자는 ${min}~${max} 범위로 입력해 주세요.`); return v; };
const json = (v: unknown): Json => { validateJson(v); return structuredClone(v) as Json; };
const identifier = (v: unknown) => { const s=text(v,100,false);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s))throw new Error("자료·파일 ID 형식을 확인해 주세요.");return s; };
const date = (v: unknown) => { const s=text(v,80,false);if(!Number.isFinite(Date.parse(s)))throw new Error("날짜 형식을 확인해 주세요.");return s; };

/** 파일 이름은 ZIP과 실행 환경에서도 그대로 사용할 수 있는 상대 경로만 허용한다. */
export function safeResourcePath(value: unknown): string {
  const path = text(value,240,false).normalize("NFC");
  if(path.startsWith("/")||path.includes("\\")||/[\x00-\x1f\x7f:]/.test(path)||path.split("/").some(part=>!part||[".","..",".git","node_modules","__pycache__"].includes(part)||/^\.env(?:\.|$)/i.test(part)||/[. ]$/.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))throw new Error("첨부 경로는 안전한 상대 폴더/파일명으로 입력해 주세요. .env와 상위 폴더 이동은 허용하지 않아요.");
  if(/\.(?:pem|key)$/i.test(path))throw new Error("개인 키 파일은 자료에 첨부하지 마세요.");
  return path;
}

export function parseResourceAttachments(value: unknown, type?: string): ResourceAttachment[] {
  if(!Array.isArray(value)||value.length>RESOURCE_FILES_MAX_COUNT)throw new Error(`첨부는 ${RESOURCE_FILES_MAX_COUNT}개까지 등록할 수 있어요.`);
  const files=value.map(raw=>{
    const f=own(raw,["id","path","mimeType","size","sha256","createdAt","exportPath"]), path=safeResourcePath(f.path);
    if(type==="skill"&&path.toLowerCase()==="skill.md")throw new Error("SKILL.md는 지침 본문에서 만들어져요. 파일 내용을 본문 편집기로 불러와 주세요.");
    const hash=text(f.sha256,64,false);if(!/^[a-f0-9]{64}$/.test(hash))throw new Error("첨부 파일 해시를 확인해 주세요.");
    return {id:identifier(f.id),path,mimeType:text(f.mimeType,120,false),size:integer(f.size,0,RESOURCE_FILE_MAX_BYTES),sha256:hash,createdAt:date(f.createdAt)};
  });
  if(new Set(files.map(f=>f.id)).size!==files.length||new Set(files.map(f=>f.path.toLowerCase())).size!==files.length)throw new Error("첨부 파일 ID나 경로가 중복되어 있어요.");
  if(files.reduce((n,f)=>n+f.size,0)>RESOURCE_FILES_MAX_BYTES)throw new Error("한 자료의 전체 첨부는 20MB 이하여야 해요.");
  return files;
}

/** 기존 자료는 undefined로 통과한다. null은 명시적인 확장 설정 제거이며 파일 삭제와는 별개다. */
export function parseResourceDetails(value: unknown, type: string, files: ResourceAttachment[] = []): ResourceDetails | undefined {
  if(value===undefined||value===null)return undefined;
  const d=own(value,["version","purpose","whenToUse","inputExample","outputExample","limitations","verification","prompt","skill","document"]);
  if(d.version!==1)throw new Error("지원하는 자료 확장 버전은 1이에요.");
  if(new TextEncoder().encode(JSON.stringify(d)).byteLength>RESOURCE_METADATA_MAX_BYTES)throw new Error("자료 상세 설정이 너무 커요.");
  const out:ResourceDetails={version:1};
  for(const key of ["purpose","whenToUse","limitations"] as const)if(d[key]!==undefined)out[key]=text(d[key],4000);
  for(const key of ["inputExample","outputExample"] as const)if(d[key]!==undefined){out[key]=json(d[key]);if(JSON.stringify(out[key]).length>20000)throw new Error("입출력 예시는 각각 20,000자 이내로 작성해 주세요.");}
  if(d.verification!==undefined){const v=own(d.verification,["kind","checkedAt","environment","scope","outcome"]);if(v.kind!=="user_reported"||!["passed","failed"].includes(String(v.outcome)))throw new Error("실행 검증 정보는 사용자가 확인한 기록으로 구분해 주세요.");out.verification={kind:"user_reported",checkedAt:date(v.checkedAt),environment:text(v.environment,500,false),scope:text(v.scope,2000,false),outcome:v.outcome as "passed"|"failed"};}
  for(const key of ["prompt","skill","document"])if(d[key]!==undefined&&key!==type)throw new Error("자료 종류가 바뀌었어요. 이전 종류의 상세 설정을 명시적으로 정리해 주세요.");
  if(d.prompt!==undefined){
    const p=own(d.prompt,["variables","role","goal","outputFormat","sampleInput"]);
    if(!Array.isArray(p.variables)||p.variables.length>40)throw new Error("Prompt 변수는 40개까지 등록할 수 있어요.");
    const variables=p.variables.map(raw=>{const v=own(raw,["name","type","required","defaultValue","description"]);const name=text(v.name,64,false);if(!safeField(name)||!["string","number","boolean","object","array"].includes(String(v.type))||typeof v.required!=="boolean")throw new Error("Prompt 변수 이름·자료형·필수 여부를 확인해 주세요.");const schema=parseSchema({type:v.type});if(v.defaultValue!==undefined)assertSchema(json(v.defaultValue),schema,`기본값 ${name}`);return {name,type:schema.type,required:v.required,...(v.defaultValue!==undefined?{defaultValue:json(v.defaultValue)}:{}),...(v.description!==undefined?{description:text(v.description,500)}:{})};});
    if(new Set(variables.map(v=>v.name)).size!==variables.length)throw new Error("Prompt 변수 이름이 중복되어 있어요.");
    out.prompt={variables};for(const key of ["role","goal","outputFormat"] as const)if(p[key]!==undefined)out.prompt[key]=text(p[key],4000);
    if(p.sampleInput!==undefined){const sample=json(p.sampleInput);if(!sample||typeof sample!=="object"||Array.isArray(sample)||Object.keys(sample).some(key=>!variables.some(v=>v.name===key)))throw new Error("샘플 입력은 선언한 변수 이름의 객체여야 해요.");for(const v of variables)if(Object.hasOwn(sample,v.name))assertSchema(sample[v.name],{type:v.type},`샘플 ${v.name}`);out.prompt.sampleInput=sample;}
  }
  if(d.skill!==undefined){
    const s=own(d.skill,["kind","executions"]);if(!["instruction","package","executable"].includes(String(s.kind)))throw new Error("Skill의 지침·파일 패키지·실행 정의 유형을 선택해 주세요.");
    out.skill={kind:s.kind as "instruction"|"package"|"executable"};
    if(s.executions!==undefined){if(!Array.isArray(s.executions)||s.executions.length>8||s.kind!=="executable")throw new Error("실행형 Skill에는 실행 정의를 8개까지 등록할 수 있어요.");out.skill.executions=s.executions.map(raw=>{
      const e=own(raw,["id","language","entryFileId","inputSchema","outputSchema","dependencies","timeoutMs","maxOutputBytes","effect"]),id=identifier(e.id),entryFileId=identifier(e.entryFileId),file=files.find(f=>f.id===entryFileId);
      if(!["python","javascript"].includes(String(e.language))||!file||!file.path.startsWith("scripts/")||!(e.language==="python"?/\.py$/i:/\.mjs$/i).test(file.path))throw new Error("실행 파일은 첨부한 scripts/ 아래의 .py 또는 .mjs 파일을 선택해 주세요.");
      if(!Array.isArray(e.dependencies)||e.dependencies.length>20||e.dependencies.some(v=>typeof v!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:==[A-Za-z0-9_.+-]+)?$/.test(v))||e.language==="javascript"&&e.dependencies.length)throw new Error("Python 의존성은 패키지명 또는 이름==버전으로 입력하세요. JavaScript는 Node 내장 모듈과 동봉 파일을 지원해요.");
      const inputSchema=parseSchema(e.inputSchema),outputSchema=parseSchema(e.outputSchema);if(inputSchema.type!=="object")throw new Error("Skill 입력 형식은 JSON 객체여야 해요.");if(!["read","write"].includes(String(e.effect)))throw new Error("선언한 작업 효과를 선택해 주세요. 실제 코드 실행은 항상 승인 대상이에요.");
      return {id,language:e.language as "python"|"javascript",entryFileId,inputSchema,outputSchema,dependencies:[...e.dependencies] as string[],timeoutMs:integer(e.timeoutMs,100,120000),maxOutputBytes:integer(e.maxOutputBytes,1,1000000),effect:e.effect as "read"|"write"};
    });if(new Set(out.skill.executions.map(e=>e.id)).size!==out.skill.executions.length)throw new Error("Skill 실행 ID가 중복되어 있어요.");}
    if(s.kind==="executable"&&!out.skill.executions?.length)throw new Error("실행형 Skill은 적어도 한 개의 실행 정의가 필요해요.");
  }
  if(d.document!==undefined){const doc=own(d.document,["source","authoredAt","sourceUpdatedAt","originalFileId","extractionStatus","extractedText","extractionError"]);if(!["not_requested","pending_local","provided","failed"].includes(String(doc.extractionStatus)))throw new Error("원본 파일과 텍스트 추출 상태를 구분해 주세요.");out.document={extractionStatus:doc.extractionStatus as "not_requested"|"pending_local"|"provided"|"failed"};for(const key of ["source","extractionError"] as const)if(doc[key]!==undefined)out.document[key]=text(doc[key],2000);for(const key of ["authoredAt","sourceUpdatedAt"] as const)if(doc[key]!==undefined&&doc[key]!=="")out.document[key]=date(doc[key]);if(doc.originalFileId!==undefined){const id=identifier(doc.originalFileId);if(!files.some(f=>f.id===id))throw new Error("Document 원본 파일을 현재 첨부에서 선택해 주세요.");out.document.originalFileId=id;}if(doc.extractedText!==undefined)out.document.extractedText=text(doc.extractedText,RESOURCE_CONTENT_MAX_CHARS);if(doc.extractionStatus==="provided"&&!out.document.extractedText?.trim())throw new Error("추출 텍스트 제공 상태에는 실제 텍스트가 필요해요.");}
  return out;
}

export function parseResourceNodeConfig(n:Record<string,unknown>):ResourceNodeConfig {
  const out:ResourceNodeConfig={};
  const bindings=(raw:unknown)=>{const v=own(raw,Object.keys(raw&&typeof raw==="object"?raw:{}));if(Object.keys(v).length>40)throw new Error("변수 연결은 40개까지 설정해 주세요.");return Object.fromEntries(Object.entries(v).map(([key,value])=>{if(!safeField(key)||typeof value!=="string"||!safeDataPath(value))throw new Error("변수 이름과 앞 단계 값 경로를 확인해 주세요.");return [key,value];}));};
  if(n.resourceBindings!==undefined||n.resourceValues!==undefined){if(!["resource","skill"].includes(String(n.type)))throw new Error("자료 변수는 자료/Skill 블록에만 지정해 주세요.");if(n.resourceBindings!==undefined)out.resourceBindings=bindings(n.resourceBindings);if(n.resourceValues!==undefined){const value=json(n.resourceValues);if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length>40)throw new Error("자료 변수 값은 객체여야 해요.");out.resourceValues=value;}}
  if(n.skillExecution!==undefined){if(n.type!=="skill")throw new Error("Skill 실행은 Skill 블록에서 명시적으로 선택해 주세요.");const s=own(n.skillExecution,["entryId","arguments","bindings"]),args=json(s.arguments);if(!args||typeof args!=="object"||Array.isArray(args))throw new Error("Skill 실행 인자는 객체여야 해요.");out.skillExecution={entryId:identifier(s.entryId),arguments:args,bindings:bindings(s.bindings)};}
  return out;
}

/** 본문 참조만 검사한다. 파일이 포함됐다는 이유로 실행 준비/외부 연결 성공을 주장하지 않는다. */
export function skillReferenceIssues(content:string,files:ResourceAttachment[]):string[]{
  const paths=new Set(files.map(f=>f.path));return [...new Set([...content.matchAll(/(?:\]\(|`)((?:scripts|references|assets)\/[^\s)`#]+)(?:#[^\s)`]*)?(?:\)|`)/g)].map(m=>m[1]).filter(path=>!paths.has(path)))].map(path=>`Skill 지침이 참조하는 ${path} 파일이 없어요.`);
}
