import type { Definition, FlowNode } from "../../app/lib/model";
import type { InputBinding, Json } from "../../runtime/types";
import { parseSearchConfig } from "../search-config";
import type { WorkflowDesign, WorkflowScenario } from "../workflow-design";
import { layoutWorkflow } from "../workflow-layout";
import { addCandidateReview } from "./agent-result-review";

const n = (id: string, type: FlowNode["type"], title: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, type, title, x: 240, y: 0, ...extra });
const b = (nodeId: string, path = "text"): InputBinding => ({ nodeId, path });
const graph = (nodes: FlowNode[], links: [string, string, string?][]): Definition => layoutWorkflow({ schemaVersion: 5, nodes, edges: links.map(([source, target, branch], i) => ({ id: `e${i}`, source, target, ...(branch ? { branch } : {}) })) });
const create = (items: string[], parents?: string[]) => ({ type: "create", items, ...(parents ? { parents } : {}) });
const modelReplies = (replies: Record<string, Json>[]): WorkflowScenario["modelReplies"] => replies.map((reply, index) => ({ match: "FLOWLY_CANDIDATE_SEARCH:", occurrence: index + 1, text: JSON.stringify(reply), allowedTools: [] }));
const treeInput = JSON.stringify({ items: [{ id: "a", value: 6 }, { id: "b", value: 4 }, { id: "c", value: 3 }], target: 7 });
const treeReplies = [{ actions: [create(["a"]), create(["b"])] }, { actions: [] }, { actions: [create(["b", "c"])] }];
const graphInput = JSON.stringify({ items: [{ id: "a", value: 2 }, { id: "b", value: 3 }, { id: "c", value: 4 }, { id: "d", value: 1 }], target: 8 });
const graphReplies = [
  { actions: [create(["a"]), create(["b"]), create(["c"])] },
  { actions: [create(["a", "b"], ["c1", "c2"]), create(["a", "b", "d"], ["c4"])] },
  { actions: [{ type: "revise", id: "c1", items: ["d"] }, create(["b", "d"], ["c1", "c2"])] },
  { actions: [create(["b", "c", "d"], ["c6", "c3"])] },
];
const search = (mode: "tree" | "graph") => n("search", "candidate_search", mode === "tree" ? "부분 후보 확장·가지치기·되돌림" : "후보 재조합·버전 계보·자손 무효화", { search: parseSearchConfig({ mode }), inputBindings: { items: b("parse", "data.items"), target: b("parse", "data.target") }, limits: { maxTurns: 12, maxTokens: 32000, maxToolCalls: 1, maxDurationMs: 120000 } });
const condition = n("solved", "condition", "원래 항목 합계가 목표와 같은가", { inputBindings: { search: b("search", "data") }, predicate: { path: "search.solved", operator: "eq", value: true } });
const held = n("held", "transform", "한도 안에서 해답을 찾지 못함", { inputBindings: {}, transform: { mode: "template", template: "검증된 해답을 찾지 못했습니다. 제한된 후보 탐색이며 해답이 없다는 수학적 증명은 아닙니다." } });
const tree: WorkflowDesign = {
  id: "p4-tree-candidate-backtracking", title: "097 · 부분 후보 트리 탐색과 막힌 가지 되돌림", category: "문제 해결·후보 탐색",
  description: "모델이 제안한 항목 조합을 원본 숫자로 계산하고, 막힌 가지에서 저장된 다른 후보로 돌아가 정답을 찾습니다.",
  behavior: "JSON 입력 → 트리 후보 탐색 → 실제 합계 검사 → 검증 결과 또는 탐색 보류. 후보 ID·부모·깊이·점수·frontier와 완료한 제안을 지속 저장합니다. 점수는 원본 목표와 합계의 차이이며 모델의 정답 선언을 신뢰하지 않습니다.",
  definition: graph([n("input", "input", "항목과 목표 합계"), n("parse", "transform", "원본 JSON 읽기", { transform: { mode: "parse_json" } }), search("tree"), condition,
    n("result", "transform", "확인한 해답과 탐색 기록", { inputBindings: { search: b("solved", "search") }, transform: { mode: "template", template: "검증된 항목: {{search.selected}} / 합계: {{search.total}} / 탐색 기록: {{search.events}}" } }), n("output", "output", "검증 결과"), held, n("held_out", "output", "탐색 보류 안내"),
  ], [["input", "parse"], ["parse", "search"], ["search", "solved"], ["solved", "result", "yes"], ["result", "output"], ["solved", "held", "no"], ["held", "held_out"]]), resources: [], inputExample: treeInput, expectedOutput: "검증된 항목 b,c / 합계 7 / c1의 막힌 가지에서 되돌린 기록",
  acceptance: ["트리 자식은 선택된 부모의 항목을 포함한다.", "상태와 모델 응답을 별도 체크포인트로 저장해 응답 저장 후 재개 시 같은 모델 요청을 반복하지 않는다.", "합계·점수·완료 여부는 원본의 정수 값으로 계산한다.", "트리 탐색은 정해진 깊이·후보 수·너비·반복 한도 안에서만 수행한다."], failureCases: ["미등록 항목·조작된 합계·잘못된 부모는 거절", "더 만들 후보가 없으면 정답을 꾸미지 않고 보류"],
  scenarios: [
    { name: "더 유망해 보인 막힌 가지에서 되돌아 형제 후보 확장", input: treeInput, modelReplies: modelReplies(treeReplies), status: "succeeded", contains: ['["b","c"]', "합계: 7", "backtracked"], outputs: { solved: { matched: true } }, modelCallCounts: { "FLOWLY_CANDIDATE_SEARCH:": 3 }, resumeAgain: true },
    { name: "아무 후보도 만들지 못하면 해답 부재를 단정하지 않고 보류", input: treeInput, modelReplies: modelReplies([{ actions: [] }]), status: "succeeded", contains: ["해답을 찾지 못했습니다", "수학적 증명은 아닙니다"], skipped: ["result"] },
    { name: "원래 입력에 없는 항목으로 정답을 꾸미면 실패", input: treeInput, modelReplies: modelReplies([{ actions: [create(["fabricated"])] }]), status: "failed", completedCounts: { search: 0, result: 0 } },
    { name: "모델이 합계와 성공 여부를 직접 지정할 수 없음", input: treeInput, modelReplies: modelReplies([{ actions: [create(["a"])], solved: true, total: 7 }]), status: "failed", completedCounts: { search: 0, result: 0 } },
  ],
};
const graphDesign: WorkflowDesign = {
  id: "p4-graph-candidate-lineage", title: "098 · 다중 부모 재조합과 조상 수정 후 재검증", category: "문제 해결·후보 탐색",
  description: "독립 부분 후보를 병합하고, 조상을 수정하면 기존 자손을 무효화한 뒤 새 버전의 부모들로 해답을 다시 만듭니다. 공개 전에 계보 기록을 사람이 확인합니다.",
  behavior: "JSON 입력 → 다중 부모 후보 그래프 → 원본 합계 검사 → 계보 검토 대기 → 수락한 해답 공개 또는 보류. 조상 수정 시 모든 기존 자손을 무효화하고 새 병합은 부모 ID와 새 revision을 기록합니다. 내부 사고 원문을 저장하지 않습니다.",
  definition: graph([n("input", "input", "부분 해답의 원본 항목"), n("parse", "transform", "원본 JSON 읽기", { transform: { mode: "parse_json" } }), search("graph"), condition,
    n("lineage_review", "review", "부분 해답의 계보와 무효화 기록 확인", { review: { instructions: "원본 목표·항목과 실제 합계를 확인하고, 조상 변경 이후 invalidated 후보가 최종 결과에 사용되지 않았는지 계보를 확인하세요. 수락은 외부 서비스 변경 승인이 아닙니다.", allowEdit: false, timeoutMinutes: 60 }, inputBindings: { data: b("solved", "search") } }),
    n("result", "transform", "수락된 해답과 새 부모 버전", { inputBindings: { search: b("lineage_review", "data") }, transform: { mode: "template", template: "계보 확인 완료 / 검증된 항목: {{search.selected}} / 합계: {{search.total}} / 후보: {{search.candidates}}" } }), n("output", "output", "검토한 해답"),
    held, n("held_out", "output", "해답 보류 안내"), n("rejected", "transform", "담당자 검토 거절", { inputBindings: {}, transform: { mode: "template", template: "계보 검토가 거절되어 해답을 공개하지 않았습니다." } }), n("rejected_out", "output", "거절 안내"),
  ], [["input", "parse"], ["parse", "search"], ["search", "solved"], ["solved", "lineage_review", "yes"], ["lineage_review", "result", "yes"], ["result", "output"], ["solved", "held", "no"], ["held", "held_out"], ["lineage_review", "rejected", "no"], ["rejected", "rejected_out"]]), resources: [], inputExample: graphInput, expectedOutput: "b,c,d 합계 8 / c1 revision2 / 기존 c4,c5 invalidated / 담당자 수락 후 공개",
  acceptance: ["다중 부모 후보는 부모 항목의 합집합을 포함하고 모든 부모 버전이 유효해야 한다.", "조상의 항목 수정은 기존 모든 자손을 무효화하며 이전 자손은 다시 병합할 수 없다.", "부분 실패한 제안 묶음은 체크포인트에 일부만 적용하지 않는다.", "검토 대기·재개는 검색 모델을 다시 호출하거나 후보 그래프를 다시 만들지 않는다."], failureCases: ["무효화된 자손을 재사용하면 실패", "담당자 거절은 결과 공개를 차단", "입력 목표·설정·체크포인트 변경은 재개 거절"],
  scenarios: [
    { name: "조상 수정으로 자손을 무효화하고 새 부모 버전으로 합성", input: graphInput, modelReplies: modelReplies(graphReplies), review: "accept", status: "succeeded", contains: ["계보 확인 완료", '["b","c","d"]', "합계: 8", '"revision":2', '"status":"invalidated"'], outputs: { solved: { matched: true } }, modelCallCounts: { "FLOWLY_CANDIDATE_SEARCH:": 4 }, resumeAgain: true },
    { name: "계보 검토 거절 후 최종 후보 공개 안 함", input: graphInput, modelReplies: modelReplies(graphReplies), review: "reject", status: "succeeded", contains: ["검토가 거절"], excludes: ["검증된 항목:"], skipped: ["result"], modelCallCounts: { "FLOWLY_CANDIDATE_SEARCH:": 4 } },
    { name: "조상 변경 후 무효화한 자손을 다시 병합하면 실패", input: graphInput, modelReplies: modelReplies([...graphReplies.slice(0, 2), { actions: [{ type: "revise", id: "c1", items: ["d"] }, create(["a", "b", "d"], ["c5"])] }]), status: "failed", completedCounts: { search: 0, lineage_review: 0, result: 0 } },
    { name: "모델 후보가 없으면 담당자 검토 없이 보류", input: graphInput, modelReplies: modelReplies([{ actions: [] }]), status: "succeeded", contains: ["해답을 찾지 못했습니다"], skipped: ["lineage_review", "result"] },
  ],
};
export const candidateSearchDesigns: WorkflowDesign[] = [tree, graphDesign].map(addCandidateReview);
