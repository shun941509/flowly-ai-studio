// 웹에서 내려받은 실행용 workflow.json을 검사하고 정규화한다. 웹 편집기 JSON과 구분되는 format/version 계약이다.
import { validateGraph, type Identity, type Resource, type Workflow } from "../app/lib/model";
import { compileDefinition, referencedResourceIds } from "../domain/workflow";
import { allNodes } from "../domain/advanced-config";
import { MAX_EXPORT_CONNECTIONS, MAX_EXPORT_RESOURCES } from "../domain/export-limits";
import { normalizeLimits } from "../runtime/policy";
import type { Limits, ToolDefinition } from "../runtime/types";
import { connectionsFor } from "../server/connections";
import { parseResourceAttachments, parseResourceDetails, safeResourcePath } from "../domain/resource-validation";

export type ExportConnection = { id: string; ownerId: string; resourceId: string; name: string; endpoint: string; endpointEnv?: string; tokenEnv?: string; tools: ToolDefinition[] };
export type ExportManifest = { format: "flowly-executable-export"; version: 1; language: "node" | "python"; exportedAt: string; owner: Identity; workflow: Workflow; resources: Omit<Resource, "allowedEmails">[]; connections: ExportConnection[]; limits?: Partial<Limits> };

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("내보낸 워크플로 형식이 올바르지 않아요.");
  return value as Record<string, unknown>;
};
const string = (value: unknown, max = 200, empty = false): string => {
  if (typeof value !== "string" || (!empty && !value) || value.length > max) throw new Error("내보낸 워크플로의 필수 값을 확인해 주세요.");
  return value;
};

/** This is a user-owned offline snapshot. The web server must authorize every included item before export. */
// 이 검사는 로컬 사본의 구조 검증이다. 원격 서비스의 현재 공유 권한은 내보내기 서버가 별도로 검사하며 로컬 파일로 철회 여부를 조회하지 않는다.
export function parseExportManifest(value: unknown): ExportManifest {
  const raw = object(value);
  if (raw.format !== "flowly-executable-export" || raw.version !== 1 || !["node", "python"].includes(String(raw.language))) throw new Error("지원하지 않는 내보내기 버전이에요. 웹에서 다시 내보내 주세요.");
  const identity = object(raw.owner);
  const owner: Identity = { userId: string(identity.userId), email: string(identity.email, 320), displayName: string(identity.displayName, 200, true) };
  const w = object(raw.workflow);
  const workflow: Workflow = { id: string(w.id), name: string(w.name), description: string(w.description, 2000, true), updatedAt: string(w.updatedAt), definition: compileDefinition(w.definition) };
  if (!Array.isArray(raw.resources) || raw.resources.length > MAX_EXPORT_RESOURCES || !Array.isArray(raw.connections) || raw.connections.length > MAX_EXPORT_CONNECTIONS) throw new Error("자료 또는 연결 목록이 올바르지 않아요.");
  const resources = raw.resources.map(value => {
    const r = object(value);
    if (!["mcp", "skill", "prompt", "document"].includes(String(r.type)) || !["private", "selected", "public"].includes(String(r.visibility)) || Object.hasOwn(r, "allowedEmails")) throw new Error("내보낸 자료 형식을 확인해 주세요. 공유 대상 목록은 포함할 수 없어요.");
    const resource: Omit<Resource, "allowedEmails"> = { id: string(r.id), ownerId: string(r.ownerId), name: string(r.name, 80), type: r.type as Resource["type"], description: string(r.description, 300, true), content: string(r.content, 200000, true), url: string(r.url, 2000, true), visibility: r.visibility as Resource["visibility"], createdAt: string(r.createdAt), updatedAt: string(r.updatedAt), ...(r.sample === true ? { sample: true } : {}) };
    if (r.files !== undefined) resource.files = parseResourceAttachments(r.files, resource.type).map((file, index) => {
      const path = string(object((r.files as unknown[])[index]).exportPath, 500);
      if (!path.startsWith(resource.type === "skill" ? "skills/" : "inputs/resources/") || !path.endsWith(`/${file.path}`)) throw new Error("자료 첨부의 내보내기 경로를 확인해 주세요.");
      safeResourcePath(path.slice(0, -(file.path.length + 1)));
      return { ...file, exportPath: path };
    });
    const details = parseResourceDetails(r.details, resource.type, resource.files);
    if (details) resource.details = details;
    return resource;
  });
  if (new Set(resources.map(r => r.id)).size !== resources.length) throw new Error("중복된 자료 ID가 있어요.");
  const ids = referencedResourceIds(workflow.definition);
  if (ids.some(id => !resources.some(r => r.id === id))) throw new Error("필요한 자료가 빠졌어요. 웹에서 다시 내보내 주세요.");
  const resourceErrors = validateGraph(workflow.definition, resources.map(r => ({ ...r, allowedEmails: [] })));
  if (resourceErrors.length) throw new Error(resourceErrors.join("\n"));
  // MCP 연결에는 소유자와 허용 필드만 인정한다. 토큰 원문이나 Python 도구 구현 지정은 manifest에 포함할 수 없다.
  for (const rawConnection of raw.connections) {
    const c = object(rawConnection);
    if (["local-python", "local-skill"].includes(String(c.id)) || c.resourceId === "local-python" || Array.isArray(c.tools) && c.tools.some(tool => ["implementation", "pythonToolId", "skillExecutionId", "skillResourceVersion"].some(key => Object.hasOwn(object(tool), key)))) throw new Error("MCP 연결로 로컬 코드의 실행 방식을 지정할 수 없어요.");
    if (Object.keys(c).some(k => !["id", "ownerId", "resourceId", "name", "endpoint", "endpointEnv", "tokenEnv", "tools"].includes(k)) || c.ownerId !== owner.userId) throw new Error("사용자 연결 정보에 허용되지 않은 값이 있어요. 비밀 값은 .env에만 등록해 주세요.");
    if (!resources.some(r => r.id === c.resourceId && r.type === "mcp")) throw new Error("연결에 해당하는 MCP 자료가 없어요.");
  }
  const connections = connectionsFor(owner, { FLOWLY_CONNECTIONS_JSON: JSON.stringify(raw.connections) });
  for (const selection of allNodes(workflow.definition).flatMap(n => n.allowedTools ?? [])) {
    if (!connections.some(c => c.id === selection.connectionId && c.resourceId === selection.resourceId && c.tools.some(t => t.toolName === selection.toolName))) throw new Error("실제로 사용할 도구 연결이 빠졌어요. 테스트 전용 도구를 실제 연결로 바꾸고 다시 내보내 주세요.");
  }
  const limits = normalizeLimits(raw.limits === undefined ? undefined : object(raw.limits) as Partial<Limits>);
  return { format: "flowly-executable-export", version: 1, language: raw.language as "node" | "python", exportedAt: string(raw.exportedAt), owner, workflow, resources, connections, limits };
}
