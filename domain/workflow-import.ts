/**
 * 웹 JSON과 실행 프로젝트 ZIP에서 설계 및 명시적인 자료 변경 후보를 읽는 경계.
 * 첨부 코드 실행·사용자 권한 복원·실행 이력 재사용을 하지 않으며 자료는 현재 사용 가능한 항목으로 다시 연결한다.
 */
import { strFromU8, unzipSync } from "fflate";
import { parseDefinition, parseResource, type Definition, type Resource, type Workflow } from "../app/lib/model";
import { allNodes, childDefinitions } from "./advanced-config";
import { compileDefinition, referencedResourceIds } from "./workflow";
import { readLegacyMcpRegistration, readMcpRegistration } from "./mcp-registration";
import { exportedAttachment, resourceFileHash } from "./resource-export";
import { EXPORT_RESOURCE_FILES_MAX_BYTES, RESOURCE_FILE_MAX_BYTES, type ResourceAttachment } from "./resource-contract";

export type ImportedResourceFile = { file: ResourceAttachment; exportPath: string; bytes?: Uint8Array; state: "unavailable" | "unchanged" | "modified" | "missing" };
export type ImportedResource = { sourceResourceId: string; baseUpdatedAt: string; data: ReturnType<typeof parseResource>; files: ImportedResourceFile[] };

/** 자료 본문/설정과 첨부 바이트 변경을 실행기 코드 변경과 구분해 표시한다. 실제 저장 권한은 서버가 재확인한다. */
export function importedResourceDiff(candidate: ImportedResource, current?: Resource) {
  const fields = ["name", "description", "content", "url", "details"] as const;
  const changedFields = fields.filter(field => JSON.stringify(candidate.data[field]) !== JSON.stringify(current?.[field]));
  const fileChanges: { path: string; change: "missing" | "modified" | "added" | "removed" }[] = candidate.files.flatMap(({ file, state }) => {
    const before = current?.files?.find(item => item.path === file.path);
    return !before || before.sha256 !== file.sha256 || before.size !== file.size || state === "missing" ? [{ path: file.path, change: state === "missing" ? "missing" as const : before ? "modified" as const : "added" as const }] : [];
  });
  for (const file of current?.files ?? []) if (!candidate.files.some(item => item.file.path === file.path)) fileChanges.push({ path: file.path, change: "removed" });
  return { fields: changedFields, files: fileChanges };
}

export type ImportOrigin = { workflowId: string; updatedAt: string; versionId?: string; versionNumber?: number };
export type WorkflowImport = {
  workflow: Workflow; origin: ImportOrigin; format: "web" | "executable";
  resourceHints: { id: string; name: string; type?: string }[];
  changedFiles: string[]; codeChanges: string[]; integrity: "unchecked" | "matched" | "changed";
  resourceChanges: ImportedResource[];
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const string = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";

/**
 * 설계와 버전 힌트를 추출하며 v1 자료 묶음은 별도의 저장 전 검토 대상으로 읽는다.
 * 외부 소유자·권한·실행 이력은 복원하지 않고 자료 사본의 초기 권한은 비공개로 정규화한다.
 */
export function parseWorkflowImport(value: unknown): WorkflowImport {
  if (!record(value) || !record(value.workflow)) throw new Error("Flowly의 워크플로 JSON 또는 실행 프로젝트 ZIP을 선택해 주세요.");
  const format = value.format === "flowly-workflow" ? "web" : value.format === "flowly-executable-export" ? "executable" : undefined;
  if (!format || (format === "web" ? ![1,2,3,4,5].includes(Number(value.version)) : value.version !== 1)) throw new Error("지원하지 않는 파일 형식 또는 버전이에요. 원본 프로젝트에서 다시 내보내 주세요.");
  const raw = value.workflow;
  const definition = parseDefinition(raw.definition);
  const workflow: Workflow = { id: string(raw.id,100), name: string(raw.name,80) || "가져온 워크플로", description: string(raw.description,300), updatedAt: string(raw.updatedAt,80), definition };
  const origin = record(value.origin) ? value.origin : raw;
  const ids = referencedResourceIds(definition);
  const resources = Array.isArray(value.resources) ? value.resources.filter(record) : [];
  const selectedIds = resources.filter(resource => ids.includes(String(resource.id))).map(resource => String(resource.id));
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error("자료 ID가 중복되어 있어요. 원본과 수정 자료를 구분해 주세요.");
  // 이전 형식은 자료 본문을 자동 수용하지 않는다. 명시적인 v1 자료 묶음만 별도의 검토 후보로 읽는다.
  if (value.resourcePackage !== undefined && (!record(value.resourcePackage) || value.resourcePackage.version !== 1 || Object.keys(value.resourcePackage).some(key => key !== "version"))) throw new Error("지원하지 않는 자료 묶음 버전이에요.");
  const resourceChanges: ImportedResource[] = value.resourcePackage ? resources.filter(resource => ids.includes(String(resource.id))).map(resource => {
    const data = parseResource({ name: resource.name, type: resource.type, description: resource.description, content: resource.content, url: resource.url, visibility: "private", allowedEmails: [], ...(resource.details !== undefined ? { details: resource.details } : {}), ...(resource.files !== undefined ? { files: resource.files } : {}) });
    const sourceResourceId = string(resource.id, 100), baseUpdatedAt = string(resource.updatedAt, 80);
    if (!sourceResourceId || !baseUpdatedAt || !Number.isFinite(Date.parse(baseUpdatedAt))) throw new Error("수정 자료의 원본 ID와 기준 버전을 확인해 주세요.");
    const sources = resources.map(item => ({ id: String(item.id), type: item.type as Resource["type"] }));
    const files = (data.files ?? []).map(file => {
      const expected = exportedAttachment(sources, sourceResourceId, file).exportPath!;
      const raw = (resource.files as Record<string, unknown>[]).find(item => item.id === file.id);
      if (raw?.exportPath !== expected) throw new Error("자료 첨부의 내보낸 경로가 원본 자료 폴더와 맞지 않아요.");
      return { file, exportPath: expected, state: "unavailable" as const };
    });
    return { sourceResourceId, baseUpdatedAt, data, files };
  }) : [];
  return { workflow, origin: { workflowId: string(origin.workflowId || raw.id,100), updatedAt: string(origin.updatedAt,80), ...(Number.isSafeInteger(origin.versionNumber)&&Number(origin.versionNumber)>0?{versionNumber:Number(origin.versionNumber),versionId:string(origin.versionId,100)}:{}) }, format,
    resourceHints: ids.map(id=>{const item=resources.find(item=>item.id===id);return {id,name:string(item?.name,80)||id,...(typeof item?.type==="string"?{type:item.type}:{})};}),
    changedFiles: [], codeChanges: [], integrity: "unchecked", resourceChanges };
}

/** Bounded ZIP inspection, with no extraction or execution. Unknown files are not read. */
/**
 * 압축 크기와 경로를 제한해 메모리에서 파일 목록을 검사한다. 해시 일치는 패키지 내 비교 결과이며 서명이나 발행자 인증은 아니다.
 */
export async function readWorkflowImport(name: string, bytes: Uint8Array): Promise<WorkflowImport> {
  if (bytes.byteLength > 30_000_000) throw new Error("가져올 파일은 30MB 이하로 선택해 주세요. 큰 프로젝트는 workflow.json만 선택할 수 있어요.");
  if (!name.toLowerCase().endsWith(".zip")) {
    if (bytes.byteLength > 8_000_000) throw new Error("워크플로 JSON은 8MB 이하로 선택해 주세요.");
    return parseWorkflowImport(JSON.parse(strFromU8(bytes)));
  }
  let total = 0;
  const entries = unzipSync(bytes, { filter: entry => {
    if (entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.includes(":") || /[\x00-\x1f]/.test(entry.name) || entry.name.split("/").includes("..")) throw new Error("ZIP 안의 파일 경로가 올바르지 않아요.");
    total += entry.originalSize;
    if (total > 60_000_000 || entry.originalSize > 15_000_000) throw new Error("ZIP의 압축 해제 크기가 너무 커요. workflow.json만 선택해 주세요.");
    if (entry.name.split("/").some(part => /^\.env(?:\.|$)/i.test(part) || part.startsWith(".flowly-"))) return false;
    return entry.name === "workflow.json" || entry.name === "PROJECT_FILES.json" || entry.name === "agent-manifest.json" || /\.(?:py|mjs|md|json|txt)$/.test(entry.name) || entry.name.startsWith("inputs/resources/") || entry.name.startsWith("skills/");
  }});
  if (!entries["workflow.json"]) throw new Error("ZIP 최상위의 workflow.json이 없어요. 내보낸 프로젝트 폴더의 파일을 선택해 주세요.");
  if (entries["workflow.json"].byteLength > 8_000_000) throw new Error("워크플로 JSON은 8MB 이하로 선택해 주세요.");
  const parsed = parseWorkflowImport(JSON.parse(strFromU8(entries["workflow.json"])));
  let fileBytes = 0;
  const materialPaths = new Set<string>();
  for (const resource of parsed.resourceChanges) for (const attachment of resource.files) {
    if (materialPaths.has(attachment.exportPath)) throw new Error("여러 자료가 같은 첨부 파일 경로를 사용해요.");
    materialPaths.add(attachment.exportPath);
    const bytes = entries[attachment.exportPath];
    if (!bytes) { attachment.state = "missing"; continue; }
    fileBytes += bytes.byteLength;
    if (bytes.byteLength > RESOURCE_FILE_MAX_BYTES || fileBytes > EXPORT_RESOURCE_FILES_MAX_BYTES) throw new Error("첨부는 파일당 5MB, 전체 20MB까지 가져올 수 있어요.");
    const sha256 = await resourceFileHash(bytes);
    attachment.state = sha256 === attachment.file.sha256 && bytes.byteLength === attachment.file.size ? "unchanged" : "modified";
    attachment.bytes = bytes;
    attachment.file = { ...attachment.file, size: bytes.byteLength, sha256 };
  }
  const inventoryBytes = entries["PROJECT_FILES.json"] || entries["agent-manifest.json"];
  if (!inventoryBytes) return parsed;
  const inventory: unknown = JSON.parse(strFromU8(inventoryBytes));
  if (!record(inventory) || !record(inventory.files)) throw new Error("프로젝트 파일 비교 기준을 읽을 수 없어요. workflow.json만 선택하거나 다시 내보내 주세요.");
  const changed = [];
  for (const [path, expected] of Object.entries(inventory.files)) {
    if (!/\.(?:py|mjs|md|json|txt)$/.test(path) && !materialPaths.has(path)) continue;
    const content = entries[path];
    const actual = content ? await resourceFileHash(content) : "";
    if (actual !== expected) changed.push(path);
  }
  for (const path of Object.keys(entries)) if (/\.(?:py|mjs)$/.test(path) && !Object.hasOwn(inventory.files,path)) changed.push(path);
  parsed.changedFiles = changed; parsed.codeChanges = changed.filter(path=>/\.(?:py|mjs)$/.test(path) && !materialPaths.has(path)); parsed.integrity = changed.length ? "changed" : "matched";
  return parsed;
}

/**
 * 설계 사본의 자료 참조와 MCP 연결을 현재 목록에 맞게 치환하고 다시 컴파일한다. 저장 API는 현재 권한을 별도로 확인해야 한다.
 */
export function rebindImportedWorkflow(imported: WorkflowImport, mapping: Record<string,string>, available: Resource[]): Workflow {
  const workflow: Workflow = {...imported.workflow, definition: structuredClone(imported.workflow.definition)};
  const replace = (id: string) => {
    const replacement = mapping[id] || id;
    const resource = available.find(value=>value.id===replacement);
    if (!resource) throw new Error(`‘${imported.resourceHints.find(hint=>hint.id===id)?.name||id}’ 자료를 현재 사용할 수 있는 자료에 다시 연결해 주세요.`);
    const type = imported.resourceHints.find(hint=>hint.id===id)?.type;
    if (type && type !== resource.type) throw new Error("원본 자료와 같은 종류의 자료를 선택해 주세요.");
    return resource;
  };
  for (const node of allNodes(workflow.definition)) {
    if(node.resourceId) node.resourceId=replace(node.resourceId).id;
    if(node.retrieval) node.retrieval.resourceIds=node.retrieval.resourceIds.map(id=>replace(id).id);
    if(node.knowledge) {
      node.knowledge.resourceIds=node.knowledge.resourceIds.map(id=>replace(id).id);
      if(node.knowledge.evaluation) node.knowledge.evaluation=node.knowledge.evaluation.map(item=>({...item,resourceId:replace(item.resourceId).id}));
    }
    if(node.allowedTools) node.allowedTools=node.allowedTools.map(tool=>{
      const resource=replace(tool.resourceId);
      const registration=readMcpRegistration(resource)??readLegacyMcpRegistration(resource);
      if(!registration || !registration.tools.some(candidate=>candidate.name===tool.toolName)) throw new Error(`‘${resource.name}’의 ${tool.toolName} 도구 정의를 확인해 주세요.`);
      return {...tool,resourceId:resource.id,connectionId:registration.connectionId};
    });
  }
  workflow.definition=compileDefinition(workflow.definition);
  return workflow;
}

function flattened(definition: Definition, scope="root"): Map<string,unknown> {
  const result=new Map<string,unknown>();
  for(const node of definition.nodes){result.set(`${scope}/${node.id}`,node);childDefinitions(node).forEach((child,index)=>flattened(child,`${scope}/${node.id}/${index}`).forEach((value,key)=>result.set(key,value)));}
  result.set(`${scope}/connections`,definition.edges);return result;
}
/**
 * 중첩 경로별 노드·연결 및 프로젝트 설명의 변경 목록을 만든다. 실행기 소스 코드를 캔버스 노드로 역변환하지 않는다.
 */
export function workflowImportDiff(previous: Workflow | undefined, next: Workflow): {added:string[];removed:string[];changed:string[]} {
  const before=previous?flattened(previous.definition):new Map<string,unknown>(),after=flattened(next.definition);
  if(previous){before.set("project/name",previous.name);before.set("project/description",previous.description);}after.set("project/name",next.name);after.set("project/description",next.description);
  return {added:[...after.keys()].filter(key=>!before.has(key)),removed:[...before.keys()].filter(key=>!after.has(key)),changed:[...after.keys()].filter(key=>before.has(key)&&JSON.stringify(before.get(key))!==JSON.stringify(after.get(key)))};
}
