"use client";
import { useState } from "react";
import type { FlowNode } from "../lib/model";
import { parseDataNodeConfig } from "../../domain/node-config";
import type { ProgramConfig } from "../../runtime/types";
import { PythonToolPicker } from "./python-tools";
import { getToolCandidate } from "../../domain/tool-catalog";
import completionContracts from "../../domain/completion-operations.json";

export const programLabels = {
  numeric_summary: "숫자 합계·평균 검산", schema_check: "결과 형식 검사", schema_patch: "오류 필드만 수정",
  evidence_check: "출처·버전·인용 대조", goal_check: "완료 조건 검사", rank_fusion: "검색 순위 통합",
  python_tool: "Python 도구 · 검색·분석·검증",
  completion: "업무 프로그램 · 계산·변경 영향·검증",
} as const;
export function programDefaults(name: ProgramConfig["name"] = "numeric_summary"): { program: ProgramConfig } {
  const config: Record<ProgramConfig["name"], Pick<ProgramConfig, "arguments" | "bindings">> = {
    numeric_summary: { arguments: {}, bindings: { values: "data.values" } },
    schema_check: { arguments: { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } }, bindings: { data: "data" } },
    schema_patch: { arguments: { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } }, bindings: { data: "data.original", patches: "data.patches" } },
    evidence_check: { arguments: {}, bindings: { claims: "data.claims", sources: "data.sources" } },
    goal_check: { arguments: { checks: [{ path: "passed", operator: "eq", value: true }] }, bindings: { data: "data" } },
    rank_fusion: { arguments: { topK: 3, rankConstant: 60 }, bindings: { lists: "data" } },
    python_tool: { arguments: { toolId: "bm25", arguments: {} }, bindings: { arguments: "data" } },
    completion: { arguments: { operation: "research.policy_diff", arguments: {} }, bindings: { arguments: "data" } },
  };
  return { program: { name, ...structuredClone(config[name]) } };
}

function ProgramFields({ node, onChange }: { node: FlowNode; onChange: (node: FlowNode) => void }) {
  const config = node.program ?? programDefaults().program;
  const [args, setArgs] = useState(JSON.stringify(config.arguments, null, 2));
  const [bindings, setBindings] = useState(JSON.stringify(config.bindings, null, 2));
  const [error, setError] = useState("");
  const changed = args !== JSON.stringify(config.arguments, null, 2) || bindings !== JSON.stringify(config.bindings, null, 2);
  function apply() {
    try {
      const program = parseDataNodeConfig({ type: "program", program: { name: config.name, arguments: JSON.parse(args), bindings: JSON.parse(bindings) } }).program!;
      onChange({ ...node, program }); setError("");
    } catch (error) { setError(error instanceof SyntaxError ? "고정 값과 값 연결은 JSON 객체로 입력해 주세요." : (error as Error).message); }
  }
  return <><label className="field-label">등록 프로그램<select value={config.name} onChange={event => onChange({ ...node, ...programDefaults(event.target.value as ProgramConfig["name"]) })}>{Object.entries(programLabels).map(([name, label]) => <option value={name} key={name}>{label}</option>)}</select></label>
    {config.name === "python_tool" && <PythonToolPicker value={typeof config.arguments.toolId === "string" ? config.arguments.toolId : ""} onChange={toolId => { const next = { ...config, arguments: { ...config.arguments, toolId } }; onChange({ ...node, program: next }); setArgs(JSON.stringify(next.arguments, null, 2)); }} />}
    {config.name === "completion" && <><label className="field-label">업무 연산<select value={String(config.arguments.operation)} onChange={event => { const next = { ...config, arguments: { ...config.arguments, operation: event.target.value } }; onChange({ ...node, program: next }); setArgs(JSON.stringify(next.arguments, null, 2)); }}>{completionContracts.operations.map(item => <option key={item.id} value={item.id}>{item.id} · {item.description}</option>)}</select></label><button type="button" className="btn secondary" onClick={() => { const contract = completionContracts.operations.find(item => item.id === config.arguments.operation); if (!contract) return; setArgs(JSON.stringify({ operation: contract.id, arguments: contract.exampleArguments }, null, 2)); setBindings("{}"); }}>연산 입력 예제 불러오기</button><p className="field-help">선택한 등록 프로그램을 내보낸 환경의 Python으로 실행해요. 연산 ID는 고정하고 arguments 객체만 앞 단계 데이터와 연결합니다. 필요한 파일은 ZIP에 함께 들어 있어요.</p></>}
    {config.name === "python_tool" && <button type="button" className="btn secondary" onClick={() => { const toolId = String(config.arguments.toolId); const candidate = getToolCandidate(toolId); if (!candidate) return; setArgs(JSON.stringify({ toolId, arguments: candidate.exampleArguments }, null, 2)); setBindings("{}"); setError(""); }}>예제 입력 불러오기 (앞 단계 연결 초기화)</button>}
    <label className="field-label">고정 입력 (JSON 객체)<textarea rows={7} maxLength={20000} value={args} onChange={event => { setArgs(event.target.value); setError(""); }} /></label>
    <label className="field-label">앞 단계 값 연결 (입력 이름: 경로)<textarea rows={5} maxLength={20000} value={bindings} onChange={event => { setBindings(event.target.value); setError(""); }} /></label>
    <button type="button" className="btn secondary" disabled={!changed && Boolean(node.program)} onClick={apply}>입력 설정 적용</button>
    <p className="field-help">{changed ? "입력 설정 적용을 눌러 변경을 반영하세요." : "현재 설정이 블록에 적용되어 있어요."} 값 연결은 고정 입력보다 우선하며, 출력은 text와 data예요. 실제 계산·검사는 내보낸 실행기에서 진행해요.</p>
    <p className="field-help">내장 계산·검증 또는 등록된 Python 도구를 선택해요. Python 도구의 입력은 arguments 객체에 지정하고 도구 ID는 고정합니다. 필요한 패키지·모델이 없으면 미설정으로 중단돼요. 출처 존재 검사와 의미적 정확성 검토는 구분됩니다.</p>
    {error && <p className="form-error" role="alert">{error}</p>}</>;
}
export function ProgramNodeSettings(props: { node: FlowNode; onChange: (node: FlowNode) => void }) {
  return <ProgramFields key={`${props.node.id}:${props.node.program?.name ?? "numeric_summary"}`} {...props} />;
}
