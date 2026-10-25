import type { Definition, FlowNode } from "../app/lib/model";
import { allNodes } from "../domain/advanced-config";
import { dataAt } from "./data-nodes";
import { canonicalJson } from "./policy";
import type { Json } from "./types";

export function selectedCompletionOperations(definition: Definition): string[] {
  return [...new Set(allNodes(definition).filter(node => node.type === "program" && node.program?.name === "completion").map(node => String(node.program!.arguments.operation)))].sort();
}
export function completionArguments(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const config = node.program!;
  const args = config.bindings.arguments ? dataAt(input, config.bindings.arguments) : config.arguments.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("업무 검증 프로그램 입력에는 JSON 객체를 연결해 주세요.");
  canonicalJson(args);
  return structuredClone(args);
}
