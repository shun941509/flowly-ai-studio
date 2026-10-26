/** 자료 본문·Prompt·첨부 경로를 실제 노드 출력으로 만들고 선택한 Skill 코드의 도구 계약을 고정한다. */
import type { FlowNode, Resource } from "../app/lib/model";
import type { Json, ToolDefinition } from "./types";
import { canonicalJson, RuntimeFault } from "./policy";
import { dataAt } from "./data-nodes";
import { resolveResourcePrompt } from "../domain/resource-prompt";

export function resourceNodeOutput(node: FlowNode, resource: Resource, input: Record<string, Json>): Record<string, Json> {
  const rendered = resolveResourcePrompt(resource, input, node.resourceValues, node.resourceBindings);
  const document = resource.details?.document;
  const content = document?.extractionStatus === "provided" && document.extractedText !== undefined ? document.extractedText : rendered.text;
  const files = (resource.files ?? []).map(file => ({ id: file.id, path: file.path, mimeType: file.mimeType, size: file.size, sha256: file.sha256, ...(file.exportPath ? { exportPath: file.exportPath } : {}) }));
  const original = files.find(file => file.id === document?.originalFileId);
  return { ...input, text: `${String(input.text ?? "")}\n\n[${resource.name}]\n${content}`,
    resource: { id: resource.id, version: resource.updatedAt, type: resource.type, content, ...(files.length ? { files } : {}) },
    ...(resource.details?.prompt ? { prompt: { text: rendered.text, values: rendered.values } } : {}),
    ...(document ? { document: { extractionStatus: document.extractionStatus, ...(original?.exportPath ? { originalPath: original.exportPath } : {}), ...(document.source ? { source: document.source } : {}) } } : {}) };
}

/** 코드는 effect 선언과 무관하게 승인 대상이다. 본문이 아닌 구조화된 실행 ID/파일/스키마로만 실행 권한을 정한다. */
export function skillToolDefinition(node: FlowNode, resources: Resource[]): ToolDefinition {
  const resource = resources.find(value => value.id === node.resourceId && value.type === "skill");
  const entry = resource?.details?.skill?.executions?.find(value => value.id === node.skillExecution?.entryId);
  if (node.type !== "skill" || !resource || resource.details?.skill?.kind !== "executable" || !entry || !resource.files?.some(file => file.id === entry.entryFileId)) throw new RuntimeFault("failed", "명시적으로 선택한 Skill 실행 정의와 진입 파일을 확인해 주세요.");
  return { resourceId: resource.id, connectionId: "local-skill", toolName: entry.id, name: `skill_${entry.id.slice(0, 58)}`, description: `${resource.name}: 선택한 ${entry.language} 코드를 실행합니다. 코드 실행 승인이 필요합니다.`, inputSchema: entry.inputSchema, outputSchema: entry.outputSchema, outputTarget: "result", effect: "write", implementation: "skill", skillExecutionId: entry.id, skillResourceVersion: resource.updatedAt };
}

export function skillArguments(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const args = structuredClone(node.skillExecution!.arguments);
  for (const [name, path] of Object.entries(node.skillExecution!.bindings)) args[name] = dataAt(input, path);
  canonicalJson(args);
  return args;
}

/** 감독 프로세스에는 지침 본문·다른 실행 정의를 보내지 않는다. 선택 코드의 고정 파일·입출력 계약만 전달한다. */
export function skillExecutionMaterial(resource: Pick<Resource, "files" | "details">, entryId: string): Json {
  const execution = resource.details?.skill?.executions?.find(entry => entry.id === entryId);
  if (!execution) throw new RuntimeFault("failed", "선택한 Skill 실행 정의가 없어요.");
  return { files: (resource.files ?? []) as unknown as Json, details: { skill: { kind: "executable", executions: [execution as unknown as Json] } } };
}
