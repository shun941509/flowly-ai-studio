"use client";
import { Modal } from "./common";
import { useTextDraft } from "./control-fields";
/**
 * 등록된 계산·검증 프로그램의 고정 인자와 동적 입력 연결을 편집한다. 임의 코드를 받거나 웹에서 Python을 실행하지 않는다.
 */

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
/** 프로그램별 예시 인자와 입력 경로를 복제하여 반환한다. 서로 다른 노드가 같은 설정 객체를 공유하지 않게 한다. */
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

/** 고정 인자·경로 JSON을 초안으로 편집하고 공통 파서로 검사한 뒤 반영한다. 실행 시에는 연결된 값이 고정 입력보다 우선한다. */
function ProgramFields({ node, onChange }: { node: FlowNode; onChange: (node: FlowNode) => void }) {
  const config = node.program ?? programDefaults().program;
  const {draft:args,setDraft:setArgs,reset:resetArgs,stale:argsStale}=useTextDraft(JSON.stringify(config.arguments,null,2));
  const {draft:bindings,setDraft:setBindings,reset:resetBindings,stale:bindingsStale}=useTextDraft(JSON.stringify(config.bindings,null,2));
  const [pendingProgram,setPendingProgram]=useState<ProgramConfig["name"]|null>(null);
  const [error, setError] = useState("");
  const changed = args !== JSON.stringify(config.arguments, null, 2) || bindings !== JSON.stringify(config.bindings, null, 2);
  function apply() {
    try {
      const program = parseDataNodeConfig({ type: "program", program: { name: config.name, arguments: JSON.parse(args), bindings: JSON.parse(bindings) } }).program!;
      onChange({ ...node, program }); setError("");
    } catch (error) { setError(error instanceof SyntaxError ? "고정 값과 값 연결은 JSON 객체로 입력해 주세요." : (error as Error).message); }
  }
  return <>{pendingProgram&&<Modal size="confirm" title="프로그램 입력을 바꿀까요?" onClose={()=>setPendingProgram(null)}><div className="modal-body"><p>프로그램별 입력 계약이 달라 고정 입력과 연결을 새 프로그램의 기본값으로 바꿉니다. 현재 JSON 초안도 초기화됩니다.</p></div><footer className="modal-footer"><button type="button" className="btn secondary" onClick={()=>setPendingProgram(null)}>현재 입력 유지</button><button type="button" className="btn primary" onClick={()=>{const next=programDefaults(pendingProgram);onChange({...node,...next});setArgs(JSON.stringify(next.program.arguments,null,2));setBindings(JSON.stringify(next.program.bindings,null,2));setPendingProgram(null);setError("");}}>확인하고 프로그램 변경</button></footer></Modal>}{(argsStale||bindingsStale)&&<p className="draft-stale">적용된 입력이 바뀌었지만 JSON 초안은 유지했습니다.</p>}<button type="button" className="text-btn" onClick={()=>{resetArgs();resetBindings();setError("");}}>최신 적용 입력으로 되돌리기</button><label className="field-label">등록 프로그램<select value={config.name} onChange={event => setPendingProgram(event.target.value as ProgramConfig["name"])}>{Object.entries(programLabels).map(([name, label]) => <option value={name} key={name}>{label}</option>)}</select></label>
    {config.name === "python_tool" && <PythonToolPicker value={typeof config.arguments.toolId === "string" ? config.arguments.toolId : ""} onChange={toolId => { const next = { ...config, arguments: { ...config.arguments, toolId } }; onChange({ ...node, program: next }); }} />}
    {config.name === "completion" && <><label className="field-label">업무 연산<select value={String(config.arguments.operation)} onChange={event => { const next = { ...config, arguments: { ...config.arguments, operation: event.target.value } }; onChange({ ...node, program: next }); }}>{completionContracts.operations.map(item => <option key={item.id} value={item.id}>{item.id} · {item.description}</option>)}</select></label><button type="button" className="btn secondary" onClick={() => { const contract = completionContracts.operations.find(item => item.id === config.arguments.operation); if (!contract) return; setArgs(JSON.stringify({ operation: contract.id, arguments: contract.exampleArguments }, null, 2)); setBindings("{}"); }}>연산 입력 예제 불러오기</button><p className="field-help">선택한 등록 프로그램을 내보낸 환경의 Python으로 실행해요. 연산 ID는 고정하고 arguments 객체만 앞 단계 데이터와 연결합니다. 필요한 파일은 ZIP에 함께 들어 있어요.</p></>}
    {config.name === "python_tool" && <button type="button" className="btn secondary" onClick={() => { const toolId = String(config.arguments.toolId); const candidate = getToolCandidate(toolId); if (!candidate) return; setArgs(JSON.stringify({ toolId, arguments: candidate.exampleArguments }, null, 2)); setBindings("{}"); setError(""); }}>예제 입력 불러오기 (앞 단계 연결 초기화)</button>}
    <label className="field-label">고정 입력 (JSON 객체)<textarea rows={7} maxLength={20000} value={args} onChange={event => { setArgs(event.target.value); setError(""); }} /></label>
    <label className="field-label">앞 단계 값 연결 (입력 이름: 경로)<textarea rows={5} maxLength={20000} value={bindings} onChange={event => { setBindings(event.target.value); setError(""); }} /></label>
    <button type="button" className="btn secondary" disabled={!changed && Boolean(node.program)} onClick={apply}>입력 설정 적용</button>
    <p className="field-help">{changed ? "입력 설정 적용을 눌러 변경을 반영하세요." : "현재 설정이 블록에 적용되어 있어요."} 값 연결은 고정 입력보다 우선하며, 출력은 text와 data예요. 실제 계산·검사는 내보낸 실행기에서 진행해요.</p>
    <p className="field-help">내장 계산·검증 또는 등록된 Python 도구를 선택해요. Python 도구의 입력은 arguments 객체에 지정하고 도구 ID는 고정합니다. 필요한 패키지·모델이 없으면 미설정으로 중단돼요. 출처 존재 검사와 의미적 정확성 검토는 구분됩니다.</p>
    {error && <p className="form-error" role="alert">{error}</p>}</>;
}
/** 노드를 바꾸면 폼을 새로 열고, 프로그램 변경은 확인 후 입력을 바꾼다. 다른 속성 변경에는 JSON 초안을 보존한다. */
export function ProgramNodeSettings(props: { node: FlowNode; onChange: (node: FlowNode) => void }) {
  return <ProgramFields key={props.node.id} {...props} />;
}
