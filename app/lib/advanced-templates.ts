import type { Definition, FlowNode, NodeType } from "./model";
import { v5Template, v5Templates } from "./v5-templates";

export const advancedTemplates = [
  ...v5Templates,
  { id: "parallel-work", title: "여러 작업을 동시에 처리", description: "두 개의 독립 작업을 병렬로 실행하고 결과를 모아요.", tag: "병렬 작업", category: "업무 생산성", icon: "layers", count: 3 },
  { id: "agent-team", title: "작성자와 검토자 에이전트 팀", description: "첫 에이전트의 초안을 다음 에이전트가 검토해요.", tag: "멀티 에이전트", category: "글쓰기 · 요약", icon: "sparkles", count: 3 },
  { id: "orchestrated-work", title: "AI가 필요한 작업 고르기", description: "허용한 작업 목록 안에서 AI가 순서를 정하고 실행해요.", tag: "오케스트레이션", category: "업무 생산성", icon: "sparkles", count: 3 },
  { id: "repeat-items", title: "목록의 항목을 하나씩 처리", description: "JSON 목록을 정해진 항목 수와 동시 수 안에서 처리해요.", tag: "반복 처리", category: "업무 생산성", icon: "layers", count: 4 },
  { id: "human-review", title: "사람이 확인한 뒤 전달", description: "로컬 실행기에서 입력을 수락·수정하거나 거절한 뒤 해당 경로로 이어가요.", tag: "사람 검토", category: "업무 생산성", icon: "check", count: 4 },
  { id: "classified-form", title: "양식으로 접수하고 AI로 분류", description: "정해진 양식의 문의를 AI가 일반 문의와 긴급 문의로 나눠요.", tag: "입력 양식 · AI 분류", category: "업무 생산성", icon: "file", count: 4 },
  { id: "reusable-work", title: "하위 흐름을 재사용", description: "값 변환 흐름의 고정 복사본을 한 작업으로 실행해요.", tag: "하위 워크플로", category: "직접 만들기", icon: "layers", count: 3 },
  { id: "remember-value", title: "다음 실행을 위한 값 보관", description: "입력 값을 내 로컬 폴더에 저장하고 다시 읽어요.", tag: "기억 읽기·쓰기", category: "업무 생산성", icon: "file", count: 4 },
];
const node = (id: string, type: NodeType, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 230, y: 30, ...extra });
const chain = (nodes: FlowNode[]): Definition => ({ schemaVersion: 4, nodes: nodes.map((n, i) => ({ ...n, y: 25 + i * 190 })), edges: nodes.slice(1).map((n, i) => ({ id: `${nodes[i].id}-${n.id}`, source: nodes[i].id, target: n.id })) });
const task = (template: string) => chain([node("input", "input", { title: "작업 입력" }), node("format", "transform", { title: "값 정리", transform: { mode: "template", template } }), node("output", "output", { title: "작업 결과" })]);
export function advancedTemplate(kind: string): Definition | undefined {
  const extended = v5Template(kind); if (extended) return extended;
  const input = node("input", "input", { title: "사용자 입력" }), output = node("output", "output", { title: "답변 출력" });
  if (kind === "parallel-work") return chain([input, node("parallel", "parallel", { title: "두 작업을 동시에 처리", parallel: { concurrency: 2, tasks: [{ id: "summary", name: "입력 확인", definition: task("받은 내용: {{text}}") }, { id: "check", name: "접수 안내", definition: task("확인할 요청: {{text}}") }] } }), output]);
  if (kind === "agent-team") {
    const writer = chain([input, node("writer", "agent", { title: "작성자", prompt: "요청에 맞는 한국어 초안을 작성하세요. 확인되지 않은 사실은 구분하세요.", allowedTools: [] }), output]);
    const reviewer = chain([input, node("reviewer", "agent", { title: "검토자", prompt: "previous로 전달된 작성자의 초안을 검토하고 수정한 최종 답변을 한국어로 제시하세요.", inputBindings: { text: { nodeId: "input", path: "text" }, previous: { nodeId: "input", path: "previous" } }, allowedTools: [] }), output]);
    return chain([input, node("team", "agent_team", { title: "작성과 검토", team: { mode: "sequential", concurrency: 1, tasks: [{ id: "writer", name: "초안 작성", definition: writer }, { id: "reviewer", name: "초안 검토", definition: reviewer }] } }), output]);
  }
  if (kind === "orchestrated-work") return chain([input, node("plan", "orchestrator", { title: "필요한 작업 선택", prompt: "요청에 적합한 작업을 1개 이상 선택하세요. 요청 확인이 필요하면 acknowledge, 문장을 정리하려면 format을 선택하세요.", orchestration: { maxTasks: 2, tasks: [{ id: "acknowledge", name: "접수 확인", definition: task("접수한 요청: {{text}}") }, { id: "format", name: "문장 정리", definition: task("처리할 내용: {{text}}") }] } }), output]);
  if (kind === "repeat-items") {
    const body = task("항목 {{index}}: {{item}}");
    body.nodes[1].inputBindings = { item: { nodeId: "input", path: "item" }, index: { nodeId: "input", path: "index" } };
    return chain([{ ...input, description: '예: ["회의 준비", "보고서 작성"]' }, node("parse", "transform", { title: "목록 읽기", transform: { mode: "parse_json" } }), node("loop", "loop", { title: "각 항목 처리", inputBindings: { data: { nodeId: "parse", path: "data" } }, loop: { definition: body, itemsPath: "data", maxItems: 10, concurrency: 2 } }), output]);
  }
  if (kind === "human-review") return { schemaVersion: 4, nodes: [input, node("review", "review", { y: 215, title: "사람이 확인", review: { instructions: "보낼 내용을 확인하고 필요하면 수정해 주세요.", allowEdit: true, timeoutMinutes: 60 } }), { ...output, x: 70, y: 405, title: "수락한 내용" }, node("rejected", "output", { x: 390, y: 405, title: "거절한 내용" })], edges: [{ id: "input-review", source: "input", target: "review" }, { id: "accept", source: "review", target: "output", branch: "yes" }, { id: "reject", source: "review", target: "rejected", branch: "no" }] };
  if (kind === "classified-form") return { schemaVersion: 4, nodes: [node("form", "form", { title: "문의 양식", form: { fields: [{ key: "name", label: "이름", type: "text", required: true }, { key: "question", label: "문의 내용", type: "text", required: true }] } }), node("classify", "classify", { y: 215, title: "문의 분류", prompt: "처리 기한이 촉박하거나 장애에 관한 문의는 긴급으로 분류하세요.", classification: { labels: [{ id: "normal", name: "일반", description: "일반적인 질문이나 요청" }, { id: "urgent", name: "긴급", description: "즉시 확인이 필요한 문의" }] } }), { ...output, x: 70, y: 405, title: "일반 문의" }, node("urgent", "output", { x: 390, y: 405, title: "긴급 문의" })], edges: [{ id: "input-classify", source: "form", target: "classify" }, { id: "normal", source: "classify", target: "output", branch: "normal" }, { id: "urgent", source: "classify", target: "urgent", branch: "urgent" }] };
  if (kind === "reusable-work") return chain([input, node("subflow", "subworkflow", { title: "저장한 정리 방식 실행", subworkflow: { definition: task("정리한 내용: {{text}}") } }), output]);
  if (kind === "remember-value") return chain([input, node("write", "memory", { title: "이번 요청 기억", memory: { action: "write", key: "last_request", valuePath: "text" } }), node("read", "memory", { title: "저장한 요청 확인", memory: { action: "read", key: "last_request", defaultValue: "" } }), { ...output, inputBindings: { text: { nodeId: "read", path: "data" } } }]);
}
