/**
 * 완료된 작업을 보존한 채 보완 입력을 기다렸다가 재개하는 예제다. 재개 후 완료 횟수와 방문 경로로 불필요한 작업 재실행을 확인한다.
 * 노드/연결/자료는 내려받을 설계이며 scenarios의 응답·상태 기대값은 테스트 전용이다.
 */
import type { Definition, FlowNode } from "../../app/lib/model";
import type { WorkflowDesign } from "../workflow-design";
import { layoutWorkflow } from "../workflow-layout";

const n = (id: string, type: FlowNode["type"], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 240, y: 0, ...extra });
const definition: Definition = layoutWorkflow({ schemaVersion: 5, nodes: [
  n("input", "input", "진행할 작업 요청"),
  n("before", "transform", "중단 전에 완료할 작업", { transform: { mode: "template", template: "접수한 요청: {{text}}" } }),
  n("supplement", "form", "담당자 보완 입력 기다리기", { form: { mode: "request", instructions: "완료된 접수 내용을 확인하고 담당자와 보완 메모를 입력하세요. 저장 후 같은 실행을 재개합니다.", timeoutMinutes: 1440, fields: [
    { key: "assignee", label: "담당자", type: "text", required: true }, { key: "note", label: "보완 메모", type: "text", required: true },
  ] } }),
  n("combine", "transform", "기존 결과와 보완 입력 결합", { inputBindings: { previous: { nodeId: "before", path: "text" }, supplied: { nodeId: "supplement", path: "data" } }, transform: { mode: "template", template: "{{previous}}\n담당자: {{supplied.assignee}}\n보완 메모: {{supplied.note}}" } }),
  n("output", "output", "재개한 최종 결과"),
], edges: [
  { id: "e0", source: "input", target: "before" }, { id: "e1", source: "before", target: "supplement" },
  { id: "e2", source: "before", target: "combine" }, { id: "e3", source: "supplement", target: "combine" }, { id: "e4", source: "combine", target: "output" },
] });

export const p1CheckpointDesigns: WorkflowDesign[] = [{
  id: "p1-checkpoint-input-recovery", title: "023 · 완료 지점 보존과 보완 입력 재개", category: "중단·재개·복구",
  description: "접수 결과를 지속 저장하고 담당자 정보를 기다립니다. 프로세스가 종료되어도 같은 실행 ID의 완료 지점부터 이어서 기존 결과와 보완 정보를 결합합니다.",
  behavior: "입력 → 접수 결과 저장 → 추가 입력 대기 → 기존 결과와 새 입력 결합 → 출력. 접수 결과는 보완 입력과 별도 연결로 보존합니다. 테스트에서는 실제 실행 프로세스를 접수 체크포인트 저장 직후 종료하고 잠금 복구·동일 ID 재개·중복 실행 방지를 확인합니다.",
  definition, resources: [], inputExample: "새 서비스 점검 요청", expectedOutput: "접수한 요청과 담당자·보완 메모를 결합한 결과",
  acceptance: ["추가 입력 전에 before 완료 결과가 디스크에 저장된다.", "추가 입력을 저장하는 명령은 후속 작업을 실행하지 않는다.", "종료된 실행기 잠금을 확인한 후 같은 실행 ID로 재개하고 before 노드를 다시 실행하지 않는다.", "보완 전후 데이터는 각각의 연결에서 가져오며 입력을 덮어쓰지 않는다.", "모델·도구가 없는 복구 예제이므로 OpenAI·MCP 설정 없이 실행할 수 있다."],
  failureCases: ["필수 담당자 누락 또는 공백은 입력 대기를 유지한다.", "실행 중인 프로세스의 잠금은 해제하지 않는다.", "같은 요청에 다른 보완 값을 다시 저장하려 하면 거절한다."],
  scenarios: [
    { name: "저장된 접수 결과와 보완 입력을 결합해 재개", input: "새 서비스 점검 요청", inputSubmissions: [{ nodeId: "supplement", values: { assignee: "운영 담당", note: "이번 주에 점검" }, repeat: true }], status: "succeeded", contains: ["접수한 요청: 새 서비스 점검 요청", "담당자: 운영 담당", "보완 메모: 이번 주에 점검"], completedCounts: { before: 1, supplement: 1, combine: 1, output: 1 }, resumeAgain: true },
    { name: "잘못된 보완 값 거절 후 동일 요청에 유효한 값 저장", input: "추가 점검 요청", inputSubmissions: [{ nodeId: "supplement", invalidValues: [{ note: "담당자 누락" }, { assignee: "   ", note: "빈 담당자" }], values: { assignee: "검증 담당", note: "보완 확인" } }], status: "succeeded", contains: ["접수한 요청: 추가 점검 요청", "담당자: 검증 담당", "보완 메모: 보완 확인"], completedCounts: { before: 1, supplement: 1, combine: 1 } },
  ],
}];
