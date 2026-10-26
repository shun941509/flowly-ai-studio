// 설계에서 선택한 고정 업무 프로그램과 입출력 매핑을 추출한다. 프로그램 자체 실행은 내보낸 Python 도우미가 담당한다.
import type { Definition, FlowNode } from "../app/lib/model";
import { allNodes } from "../domain/advanced-config";
import { dataAt } from "./data-nodes";
import { canonicalJson } from "./policy";
import type { Json } from "./types";

// 중첩 설계까지 확인하여 패키지에 필요한 작업 ID를 중복 없이 고정한다.
export function selectedCompletionOperations(definition: Definition): string[] {
  return [...new Set(allNodes(definition).filter(node => node.type === "program" && node.program?.name === "completion").map(node => String(node.program!.arguments.operation)))].sort();
}
// arguments 바인딩이 있으면 앞 단계 객체를 사용하고, 없으면 설계의 고정 인자를 복사한다.
export function completionArguments(node: FlowNode, input: Record<string, Json>): Record<string, Json> {
  const config = node.program!;
  const args = config.bindings.arguments ? dataAt(input, config.bindings.arguments) : config.arguments.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("업무 검증 프로그램 입력에는 JSON 객체를 연결해 주세요.");
  canonicalJson(args);
  return structuredClone(args);
}
