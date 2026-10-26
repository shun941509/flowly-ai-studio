// 등록된 Python 도구를 Agent/프로그램에 노출하는 계약 계층. 실행은 export-runtime의 고정 worker를 통해서만 연결한다.
import type { Definition, FlowNode } from "../app/lib/model";
import { allNodes } from "../domain/advanced-config";
import { getToolCandidate } from "../domain/tool-catalog";
import contracts from "../export-runtime/tool-contracts.json";
import type { DataSchema, Json, ToolDefinition } from "./types";
import { canonicalJson, RuntimeFault } from "./policy";
import { dataAt } from "./data-nodes";

export const PYTHON_TOOL_NAMESPACE = "local-python";
export const PYTHON_TOOL_CONTRACTS = contracts as unknown as { version: number; tools: Record<string, { inputSchema: Record<string, Json>; exampleArguments: Record<string, Json>; usage: string; dependencies?: string[]; requirements?: string[] }> };
// 도구 ID는 카탈로그와 입력 계약 양쪽에 있어야 한다. MCP 정의를 Python 구현으로 위장하는 용도로 사용하지 않는다.
export function pythonToolDefinition(id: string): ToolDefinition {
  const candidate = getToolCandidate(id);
  const contract = PYTHON_TOOL_CONTRACTS.tools[id];
  if (!candidate || !contract) throw new RuntimeFault("failed", "등록되지 않은 Python 도구예요. 도구 목록에서 다시 선택해 주세요.");
  return { implementation: "python", pythonToolId: id, resourceId: PYTHON_TOOL_NAMESPACE, connectionId: PYTHON_TOOL_NAMESPACE,
    toolName: id, name: `python_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`, description: `${candidate.description}\n${contract.usage}\n입력 예: ${JSON.stringify(contract.exampleArguments)}`,
    inputSchema: structuredClone(contract.inputSchema) as unknown as DataSchema, effect: "read" };
}
/** Python tool contracts allow unrestricted JSON value slots without relaxing workflow/MCP schemas. */
export function assertPythonArguments(value: Json, schema: Record<string, Json>, path = "도구 입력"): void {
  const type = schema.type;
  if (type && (type === "array" ? !Array.isArray(value) : type === "object" ? !value || typeof value !== "object" || Array.isArray(value) : typeof value !== type)) throw new Error(`${path} 형식이 맞지 않아요 (${type}).`);
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => canonicalJson(candidate) === canonicalJson(value))) throw new Error(`${path}의 허용 값을 확인해 주세요.`);
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, Json>>;
    for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} 값이 필요해요.`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) assertPythonArguments(child, props[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} 필드를 사용할 수 없어요.`);
    }
  }
  if (type === "array" && Array.isArray(value) && schema.items) value.forEach((child, index) => assertPythonArguments(child, schema.items as Record<string, Json>, `${path}[${index}]`));
}
export function selectedPythonToolIds(definition: Definition): string[] {
  return [...new Set(allNodes(definition).flatMap(node => node.type === "agent" ? node.pythonTools ?? [] : node.type === "program" && node.program?.name === "python_tool" ? [String(node.program.arguments.toolId)] : []))].sort();
}
// 현재 블록의 허용 목록과 정식 도구 정의를 모두 비교한다. 이름만 같거나 정의가 변경된 도구는 통과하지 못한다.
export function assertPythonToolSelected(node: FlowNode, tool: ToolDefinition): void {
  const allowed = node.type === "agent" ? node.pythonTools ?? [] : node.type === "program" && node.program?.name === "python_tool" ? [node.program.arguments.toolId] : [];
  if (!tool.pythonToolId || !allowed.includes(tool.pythonToolId) || canonicalJson(pythonToolDefinition(tool.pythonToolId)) !== canonicalJson(tool)) throw new RuntimeFault("failed", "선택하지 않았거나 변경된 Python 도구는 실행할 수 없어요.");
}
// 입력값은 연결할 수 있지만 toolId는 설계에 고정한다. 앞 단계 데이터가 실행할 도구를 임의 교체하지 못하게 한다.
export function pythonProgramArguments(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const config = node.program!;
  const args = structuredClone(config.arguments);
  args.arguments ??= {};
  for (const [name, path] of Object.entries(config.bindings)) args[name] = dataAt(input, path);
  if (args.toolId !== config.arguments.toolId || typeof args.arguments !== "object" || args.arguments === null || Array.isArray(args.arguments)) throw new RuntimeFault("failed", "Python 도구 ID는 고정하고 arguments에는 JSON 객체를 연결해 주세요.");
  canonicalJson(args.arguments);
  return args.arguments;
}
