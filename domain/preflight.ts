import { parseDefinition, validateGraph, type FlowNode, type Resource, type Workflow } from "../app/lib/model";
import type { RuntimeCapabilities } from "../runtime/types";
import { assertSchema, parseNodeRuntime } from "./schema";
import { compileDefinition, referencedResourceIds } from "./workflow";
import { parseDataNodeConfig } from "./node-config";
import { allNodes, childDefinitions, parseAdvancedNodeConfig } from "./advanced-config";
import { mappingIssues } from "./data-contract";
import { MAX_EXPORT_CONNECTIONS, MAX_EXPORT_RESOURCES } from "./export-limits";
import { nodeRequiresModel, parseExtendedNodeConfig } from "./extended-config";

export type PreflightIssue = { severity: "error" | "warning" | "info"; message: string; nodeId?: string };
/** Pure inspection only. Authorization is still repeated by the export API. */
export function inspectWorkflow(workflow: Workflow, resources: Resource[], capabilities?: RuntimeCapabilities | null) {
  const issues: PreflightIssue[] = [];
  const topLevel = new Map<FlowNode, string>();
  const add = (severity: PreflightIssue["severity"], message: string, nodeId?: string) => {
    if (!issues.some(i => i.severity === severity && i.message === message && i.nodeId === nodeId)) issues.push({ severity, message, ...(nodeId ? { nodeId } : {}) });
  };
  let requiresModel = workflow.definition.nodes.some(nodeRequiresModel);
  for (const node of workflow.definition.nodes) {
    try { parseNodeRuntime(node); parseDataNodeConfig(node as unknown as Record<string, unknown>); parseExtendedNodeConfig(node as unknown as Record<string, unknown>); parseAdvancedNodeConfig(node as unknown as Record<string, unknown>, parseDefinition); }
    catch (error) { add("error", error instanceof Error ? error.message : "블록 설정을 확인해 주세요.", node.id); }
  }
  try {
    const parsed = parseDefinition(workflow.definition);
    const inspectMappings = (graph: typeof parsed, parentId?: string) => {
      for (const node of graph.nodes) {
        for (const issue of mappingIssues(graph, node)) add(issue.severity, issue.message, parentId ?? node.id);
        for (const child of childDefinitions(node)) inspectMappings(child, parentId ?? node.id);
      }
    };
    inspectMappings(parsed);
    for (const root of parsed.nodes) for (const node of allNodes({ nodes: [root], edges: [] })) topLevel.set(node, root.id);
    requiresModel = allNodes(parsed).some(nodeRequiresModel);
    if (referencedResourceIds(parsed).length > MAX_EXPORT_RESOURCES) add("error", `하위 작업을 포함해 자료는 ${MAX_EXPORT_RESOURCES}개까지 내보낼 수 있어요. 워크플로를 나누거나 사용 자료를 줄여 주세요.`);
    if (new Set(allNodes(parsed).flatMap(n => (n.allowedTools ?? []).map(t => t.connectionId))).size > MAX_EXPORT_CONNECTIONS) add("error", `하위 작업을 포함해 서비스 연결은 ${MAX_EXPORT_CONNECTIONS}개까지 내보낼 수 있어요. 사용 연결을 줄여 주세요.`);
    for (const message of validateGraph(parsed, resources)) add("error", message, parsed.nodes.find(n => message.includes(`‘${n.title}’`))?.id);
    try { compileDefinition(parsed); } catch (error) { if (!issues.some(i => i.severity === "error")) add("error", error instanceof Error ? error.message : "블록 연결을 확인해 주세요."); }
    for (const node of allNodes(parsed)) {
      const location = topLevel.get(node) ?? node.id;
      for (const id of referencedResourceIds({ nodes: [node], edges: [] })) if (!resources.some(r => r.id === id)) add("error", "사용할 수 없는 자료가 있어요. 공유 상태를 확인해 주세요.", location);
      if (node.type === "agent" && !node.allowedTools?.length && !node.pythonTools?.length) add("info", "선택한 도구가 없어 이 에이전트는 모델 답변만 생성해요.", location);
      for (const selected of node.allowedTools ?? []) {
        if (["test-read", "test-write"].includes(selected.connectionId)) { add("error", "테스트 전용 도구를 실제 서비스 도구로 바꿔 주세요.", location); continue; }
        const connection = capabilities?.connections.find(c => c.id === selected.connectionId && c.resourceId === selected.resourceId);
        const tool = connection?.tools.find(t => t.toolName === selected.toolName);
        if (!capabilities) { add("warning", "도구 설정을 불러온 뒤 다시 점검해 주세요. 다운로드 시 서버가 최종 확인해요.", location); continue; }
        if (!tool) { add("error", "본인 계정에서 내보낼 수 있는 도구 연결을 선택해 주세요.", location); continue; }
        if (connection?.status === "unconfigured") add("warning", "서비스 연결은 미설정이에요. 내보낸 폴더에서 본인의 서비스 주소와 토큰을 설정하세요.", location);
        if (tool.effect === "write") add("warning", "외부 변경은 로컬 실행기에서 승인한 뒤 실행해요.", location);
        if (node.type === "compensate" && tool.effect !== "write") add("error", "보상 작업에는 외부 변경 도구를 선택해 주세요.", location);
        if (node.type === "memory" && node.memory?.backend === "mcp" && tool.effect !== (node.memory.action === "read" ? "read" : "write")) add("error", "기억 작업에 맞는 읽기 또는 외부 변경 도구를 선택해 주세요.", location);
        if (node.type === "tool") {
          const args = node.tool?.arguments ?? {}, bindings = node.tool?.bindings ?? {};
          for (const key of tool.inputSchema.required ?? []) if (!Object.hasOwn(args, key) && !Object.hasOwn(bindings, key)) add("error", `도구의 필수 입력 ‘${key}’에 고정 값 또는 이전 값 연결이 필요해요.`, location);
          if (!Object.keys(bindings).length) try { assertSchema(args, tool.inputSchema, "도구 입력"); } catch (error) { add("error", error instanceof Error ? error.message : "도구 입력을 확인해 주세요.", location); }
        }
      }
      if (node.type === "resource" && resources.find(r => r.id === node.resourceId)?.type === "mcp") add("warning", "자료 가져오기는 MCP 설명만 전달해요. 도구 실행은 에이전트 또는 도구 실행 블록을 사용해 주세요.", location);
      if (node.type === "retrieval") add("info", node.retrieval?.mode === "web" ? "웹 검색은 내보낸 실행기에서 모델 제공자의 검색 기능을 호출하고 출처를 반환해요." : node.retrieval?.mode === "vector" ? "벡터 검색은 내보낸 자료와 질문을 임베딩 API로 전송하고 로컬 색인을 보관해요." : "어휘 검색은 내보낸 텍스트의 단어와 한국어 어절 일부를 비교해요.", location);
      if (["file_input", "document_extract", "file_output", "trigger"].includes(node.type)) add("info", "이 기능은 내보낸 폴더에서 Python 3.11 이상의 로컬 도우미를 사용해요. 문서 형식별 추가 패키지는 ZIP 안내를 확인해 주세요.", location);
      if (node.pythonTools?.length || node.program?.name === "python_tool") add("info", "Python 도구는 내보낸 환경에서 실행해요. ZIP의 tool-manifest.json과 requirements-tools.txt를 확인하고 check로 필요한 패키지·모델 설정을 점검하세요.", location);
      if (node.program?.name === "completion") add("info", "업무 프로그램은 내보낸 환경의 Python으로 실행해요. completion-manifest.json에서 연산별 입력 계약을 확인하고 Node.js에서는 필요하면 FLOWLY_PYTHON 경로를 설정하세요.", location);
      if (node.type === "guardrail") add("warning", "민감정보 필터는 정해진 패턴만 탐지해요. 전체 개인정보나 업무기밀을 완전히 탐지하지는 않아요.", location);
    }
  } catch (error) { const message = error instanceof Error ? error.message : "워크플로 형식을 확인해 주세요."; if (!issues.some(i => i.severity === "error" && i.message === message)) add("error", message); }
  add("info", requiresModel ? "내보낸 폴더의 .env에 본인의 모델 키와 모델명을 설정하세요. 웹에서는 모델을 호출하지 않아요." : "AI 블록이 없어 OpenAI 키 없이 실행할 수 있어요. 선택한 서비스가 요구하는 토큰은 별도로 필요해요.");
  add("warning", "내보낸 자료는 복사본이므로 이후 공유 철회나 원본 변경이 적용되지 않아요.");
  return { issues, canExport: !issues.some(i => i.severity === "error"), requiresModel };
}
