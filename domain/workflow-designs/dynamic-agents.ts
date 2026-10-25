import type { Definition, FlowNode } from "../../app/lib/model";
import type { DynamicAgentSpec } from "../../runtime/types";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";
import { layoutWorkflow } from "../workflow-layout";

const n = (id: string, type: FlowNode["type"], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 0, y: 0, ...extra });
const b = (nodeId: string, path = "text") => ({ nodeId, path });
const graph = (nodes: FlowNode[], edges: [string, string, ("yes" | "no")?][]): Definition => layoutWorkflow({ schemaVersion: 5, nodes, edges: edges.map(([source, target, branch], i) => ({ id: `e${i}`, source, target, ...(branch ? { branch } : {}) })) });
const capability = graph([
  n("task_input", "input", "생성된 역할·목표·입력·선행 결과"),
  n("specialist", "agent", "허용된 분석 기능 수행", { prompt: "DYNAMIC_SPECIALIST: assignment의 역할·목표·입력을 수행하고 artifacts에 있는 선행 보고서를 검토하세요. {passed:boolean,report:string} JSON으로 관찰 가능한 결과를 답하세요. 별도 도구·권한을 요청하지 마세요.", format: "JSON", allowedTools: [], inputBindings: { assignment: b("task_input", "assignment"), artifacts: b("task_input", "artifacts") }, outputSchema: { type: "object", properties: { text: { type: "string" }, data: { type: "object", properties: { passed: { type: "boolean" }, report: { type: "string" } }, required: ["passed", "report"], additionalProperties: false } }, required: ["text", "data"] } }),
  n("needs_more", "condition", "이 역할에 담당자 보완이 필요한가", { predicate: { path: "assignment.input.needsInput", operator: "eq", value: true }, inputBindings: { assignment: b("task_input", "assignment"), data: b("specialist", "data"), text: b("specialist") } }),
  n("supplement", "form", "이 역할의 보완 정보를 기다림", { form: { mode: "request", instructions: "완료된 다른 역할은 보존합니다. 이 역할의 보완 메모를 입력한 뒤 같은 실행을 재개하세요.", fields: [{ key: "note", label: "확인한 보완 메모", type: "text", required: true }] } }),
  n("join_note", "transform", "분석 결과와 보완 메모 결합", { inputBindings: { report: b("needs_more", "data.report"), note: b("supplement", "data.note") }, transform: { mode: "template", template: "{{report}} / 보완: {{note}}" } }),
  n("supplemented", "output", "보완한 역할 결과"),
  n("direct", "output", "검사한 역할 결과", { inputBindings: { text: b("needs_more"), data: b("needs_more", "data") } }),
], [["task_input", "specialist"], ["task_input", "needs_more"], ["specialist", "needs_more"], ["needs_more", "supplement", "yes"], ["needs_more", "join_note", "yes"], ["supplement", "join_note"], ["join_note", "supplemented"], ["needs_more", "direct", "no"]]);
const definition = graph([
  n("request", "input", "검토할 목표"),
  n("spawn", "orchestrator", "목표에 맞는 하위 Agent를 생성", { prompt: "DYNAMIC_TEAM_PLAN: 사용자의 목표에서 서로 다른 분석 역할을 1~3개 생성하고 분석 결과에 의존하는 judge 역할을 추가하세요. judge는 ID judge를 사용하고 needsInput:false입니다. 모든 역할은 등록한 analysis 기능을 사용합니다. 사용자 보완이 필요한 역할만 needsInput:true입니다. 개인 사고 원문을 요청하지 말고 최종 산출물과 짧은 결정 설명만 사용하세요.", orchestration: { mode: "dynamic", maxTasks: 1, tasks: [{ id: "analysis", name: "등록된 기술 분석과 보완 입력 기능", definition: capability }], dynamic: { maxAgents: 4, concurrency: 2, templates: [{ taskId: "analysis", agentNodeId: "specialist", inputSchema: { type: "object", properties: { topic: { type: "string" }, needsInput: { type: "boolean" } }, required: ["topic", "needsInput"], additionalProperties: false } }] }, completion: [{ path: "summary.completedCount", operator: "gte", value: 2 }, { path: "artifacts.judge.data.passed", operator: "eq", value: true }] } }),
  n("result", "transform", "최종 판단과 생성 팀 규모", { inputBindings: { report: b("spawn", "artifacts.judge.data.report"), count: b("spawn", "count") }, transform: { mode: "template", template: "생성한 역할 {{count}}개\n최종 판단: {{report}}" } }),
  n("output", "output", "완료 조건을 통과한 답변"),
], [["request", "spawn"], ["spawn", "result"], ["result", "output"]]);
const assignment = (id: string, dependencies: string[] = [], needsInput = false): DynamicAgentSpec => ({ id, templateId: "analysis", role: id === "judge" ? "최종 독립 판단" : `${id} 기술 분석`, goal: id === "judge" ? "선행 분석의 일치점과 남은 위험을 판정" : `${id} 관점에서 요청을 분석`, input: { topic: id, needsInput }, dependsOn: dependencies });
const roles = [assignment("analyst_a"), assignment("analyst_b"), assignment("judge", ["analyst_a", "analyst_b"])];
const plan = (agents: unknown): NonNullable<WorkflowScenario["modelReplies"]>[number] => ({ match: "DYNAMIC_TEAM_PLAN:", text: JSON.stringify({ agents }) });
const report = (id: string, passed = true): NonNullable<WorkflowScenario["modelReplies"]>[number] => ({ match: `"id":"${id}"`, text: JSON.stringify({ passed, report: id === "judge" ? "두 관점 검증을 완료했습니다." : `${id} 검토 완료` }), ...(id === "judge" ? { inputContains: ["artifacts"] } : {}) });
const malformed: [string, unknown][] = [
  ["등록되지 않은 기능으로 권한 확장 시도 거절", [{ ...roles[0], templateId: "shell" }]],
  ["생성 계약의 임의 도구 필드 거절", [{ ...roles[0], tools: ["write_database"] }]],
  ["생성 입력의 스키마 오류 거절", [{ ...roles[0], input: { topic: 42, needsInput: false } }]],
  ["생성된 작업 간 순환 의존 거절", [assignment("analyst_a", ["judge"]), assignment("judge", ["analyst_a"])]],
  ["최대 생성 수를 초과한 계획 거절", [...roles, assignment("extra_a"), assignment("extra_b")]],
];
export const dynamicAgentDesigns: WorkflowDesign[] = [{
  id: "dynamic-subagent-task-team", title: "031 · 실행 중 역할 생성과 의존 작업 분배", category: "동적 하위 Agent",
  description: "한 개의 등록 기능에서 요청별로 새로운 역할·목표·타입 입력·작업 ID를 생성합니다. 독립 분석은 병렬로 실행하고 선행 결과가 모두 완료된 후 판단 Agent를 시작합니다.",
  behavior: "목표 입력 → 허용 기능과 스키마로 새 역할 계획 → 계획 지속 저장 → 의존 관계에 맞춰 동시 2개 실행 → 필요 역할만 보완 입력·재개 → 선행 결과를 받은 판단 Agent → 프로그램의 독립 완료 조건 → 답변. 등록 기능 선택만 바꾸는 조정과 달리 실행마다 서로 다른 역할 인스턴스와 작업 계약을 생성합니다.",
  definition, resources: [], inputExample: "서비스 변경안을 성능과 운영 관점으로 분석한 뒤 위험을 판단해 주세요.", expectedOutput: "생성 역할 수와 완료 조건을 통과한 판단 결과",
  acceptance: ["모델은 등록 기능·입력 스키마 안에서만 새 역할을 만들고 도구·코드·정책은 만들지 못한다.", "생성 계획을 자식 실행 전에 저장하고 재개할 때 같은 역할 ID·자식 실행 ID·정의/입력 해시를 검사한다.", "부모 예산 안에서 최대 4개 역할·동시 2개만 실행하고 순환·누락 선행 작업은 거절한다.", "독립 분석 결과만 의존 역할에 전달하며 보완 입력 저장으로 도구를 실행하지 않는다.", "judge의 산출물이 완료 조건을 통과해야 전체를 성공으로 표시한다."],
  failureCases: ["미등록 기능·추가 권한 필드·잘못된 입력·순환·생성 한도 초과는 자식 실행 전에 거절한다.", "판단 Agent가 passed:false로 답하면 전체 완료 조건을 실패시킨다.", "실행 후 계획·템플릿·입력이 달라지면 재개하지 않는다."],
  scenarios: [
    { name: "두 역할을 실제 병렬 실행하고 생성된 판단 역할이 수집", input: "두 전문 관점으로 검토", status: "succeeded", modelReplies: [plan(roles), { ...report("analyst_a"), delayMs: 180 }, { ...report("analyst_b"), delayMs: 180 }, { ...report("judge"), inputContains: ["analyst_a 검토 완료", "analyst_b 검토 완료"] }], parallelMatches: ['"id":"analyst_a"', '"id":"analyst_b"'], contains: ["생성한 역할 3개", "두 관점 검증"], completedCounts: { specialist: 3 }, resumeAgain: true },
    { name: "단순 목표에는 다른 크기와 연결의 두 역할만 생성", input: "하나의 관점으로 검토", status: "succeeded", modelReplies: [plan([assignment("specialist_one"), assignment("judge", ["specialist_one"])]), report("specialist_one"), report("judge")], contains: ["생성한 역할 2개"], completedCounts: { specialist: 2 } },
    { name: "한 역할의 보완 입력 후 계획 재생성 없이 재개", input: "한 분석은 담당자 확인 필요", status: "succeeded", modelReplies: [plan([assignment("analyst_a", [], true), roles[1], roles[2]]), report("analyst_a"), report("analyst_b"), { ...report("judge"), inputContains: ["확인한 배포 시간", "analyst_b 검토 완료"] }], inputSubmissions: [{ nodeId: "supplement", invalidValues: [{}], values: { note: "확인한 배포 시간" }, repeat: true }], contains: ["생성한 역할 3개"], completedCounts: { specialist: 3, supplement: 1 }, modelCallCounts: { "DYNAMIC_TEAM_PLAN:": 1, '"id":"analyst_a"': 1, '"id":"analyst_b"': 1, '"id":"judge"': 1 }, resumeAgain: true },
    { name: "최종 모델의 불충분 판단은 성공으로 바꾸지 않음", input: "완료 조건 검증", status: "failed", modelReplies: [plan(roles), report("analyst_a"), report("analyst_b"), report("judge", false)], completedCounts: { output: 0 } },
    ...malformed.map(([name, agents]): WorkflowScenario => ({ name, input: "허용 기능 경계 검증", status: "failed", modelReplies: [plan(agents)], completedCounts: { specialist: 0, output: 0 } })),
  ],
}];
