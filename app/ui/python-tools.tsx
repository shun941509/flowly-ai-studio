"use client";
/**
 * Python 도구 카탈로그의 설명·준비 사항·Agent 허용 목록을 보여준다. 설치 상태 조회나 도구 실행은 하지 않는다.
 */

import { useState } from "react";
import { SearchableMultiSelect } from "./searchable-multi-select";
import type { FlowNode, Resource } from "../lib/model";
import { TOOL_CANDIDATES, TOOL_FAMILIES, getToolCandidate, type ToolCandidate } from "../../domain/tool-catalog";

/** 소스에서 확인한 출력 항목과 좁은 구현 범위를 함께 표시한다. 준비 상태나 실행 결과를 대신하지 않는다. */
function ToolSupportDescription({ tool }: { tool: ToolCandidate }) {
  return <><p>{tool.usage}</p>{tool.support && <><h5>받을 결과</h5><p>{tool.support.outputDescription}</p><p className="field-help">가능한 출력 항목: <code>{tool.support.outputFields.join(", ")}</code> · 동작과 알고리즘에 따라 일부 항목만 반환합니다.</p><h5>현재 지원 범위</h5><p>{tool.support.limitation}</p>{tool.support.sharedImplementationIds.length > 0 && <p className="field-help">같은 알고리즘을 사용하는 항목: {tool.support.sharedImplementationIds.map(id => getToolCandidate(id)?.name ?? id).join(", ")}. 별도의 독립 엔진을 뜻하지 않습니다.</p>}</>}<h5>준비할 환경</h5><p className="field-help">필요 패키지: {tool.dependencies.join(", ") || "Python 기본 제공 기능"}{tool.modelRequired ? " · 사용자 제공 로컬 모델 필요" : ""}. 내보낸 실행 환경에서 check로 설치·설정 상태를 확인하세요.</p><details><summary>입력 예시 확인</summary><pre className="content-preview">{JSON.stringify(tool.exampleArguments, null, 2)}</pre></details><p className="field-help">소스의 처리 분기·반환값을 대조한 설명입니다. 현재 PC의 실행 성공이나 모델 품질 검증 결과가 아닙니다.</p></>;
}

/** 공통 도구 계약에서 이름·사용법·의존성·예시 입력을 표시한다. 선택 값은 등록된 도구 ID다. */
export function PythonToolPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const tool = getToolCandidate(value);
  return <><label className="field-label">등록된 Python 도구<select value={value} onChange={event => onChange(event.target.value)}>{TOOL_FAMILIES.map(family => <optgroup label={family.name} key={family.id}>{TOOL_CANDIDATES.filter(item => item.family === family.id).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>)}</select></label>{tool && <><p className="field-help">{tool.description} · 실행 전에 내보낸 폴더에서 check로 준비 상태를 확인하세요.</p><details><summary>입력 예시와 준비 사항</summary><ToolSupportDescription tool={tool} /></details></>}</>;
}

/** 사용자가 지정한 도구 ID만 Agent의 허용 목록에 추가한다. MCP 도구 수와 합쳐 최대 12개 제한을 적용한다. */
export function PythonAgentTools({ node, onChange }: { node: FlowNode; onChange: (node: FlowNode) => void }) {
  return <><SearchableMultiSelect label="Agent 허용 Python 도구" options={TOOL_CANDIDATES.map(tool => ({id:tool.id,label:tool.name,description:tool.description,category:TOOL_FAMILIES.find(f=>f.id===tool.family)?.name}))} value={node.pythonTools??[]} maxSelected={12-(node.allowedTools?.length??0)} onChange={pythonTools=>onChange({...node,pythonTools})}/><p className="field-help">실제 계산은 내보낸 환경의 Python에서 실행합니다. Node.js 내보내기도 Python과 도구별 패키지·모델이 필요합니다.</p></>;
}

/** 검색한 도구의 예시 설정을 Document 자료로 등록할 수 있게 한다. 자료 본문은 실행 코드가 아니라 flowlyPython 설정이다. */
export function PythonToolCatalog({ onCreatePreset }: { onCreatePreset?: (initial: Partial<Resource>) => void }) {
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("all");
  const [limit, setLimit] = useState(12);
  const matches = TOOL_CANDIDATES.filter(tool => (family === "all" || family === tool.family) && `${tool.name} ${tool.id} ${tool.description} ${tool.support?.outputDescription ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <details className="settings-card python-tool-catalog"><summary>Python 도구팩 · {TOOL_CANDIDATES.length}개 활용 항목</summary><p>검색·분석·검증 도구를 Agent와 계산·검증 프로그램에 연결할 수 있어요. 아래 목록은 제공 기능과 설정 안내이며, 이 컴퓨터의 설치·모델 연결 상태를 뜻하지 않아요.</p><div className="resource-search-row"><label className="field-label">도구 검색<input value={query} onChange={event => { setQuery(event.target.value); setLimit(12); }} placeholder="예: BM25, 데이터 품질, OCR"/></label><label className="field-label">기능별 보기<select value={family} onChange={event => { setFamily(event.target.value); setLimit(12); }}><option value="all">모든 기능</option>{TOOL_FAMILIES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><p>{matches.length}개 항목</p><div className="resource-grid">{matches.slice(0, limit).map(tool => <article className="settings-card" key={tool.id}><h4>{tool.name}</h4><p>{tool.description}</p><p className="field-help">{tool.id} · {TOOL_FAMILIES.find(item => item.id === tool.family)?.name}</p><details><summary>사용 범위·준비 사항</summary><ToolSupportDescription tool={tool} /></details>{onCreatePreset && <button type="button" className="btn secondary" onClick={() => onCreatePreset({ type: "document", name: `${tool.name} 실행 설정`, description: tool.description.slice(0, 300), content: JSON.stringify({ flowlyPython: { version: 1, toolId: tool.id, arguments: structuredClone(tool.exampleArguments) } }, null, 2), visibility: "private", allowedEmails: [], url: "" })}>설정 자료로 등록</button>}</article>)}</div>{matches.length > limit && <button type="button" className="btn secondary" onClick={() => setLimit(limit + 12)}>더 보기</button>}<p className="field-help">설정 자료는 Document로 저장해 기존 공유·수정·삭제 권한을 사용해요. 키와 토큰은 넣지 마세요. 자료를 워크플로에 추가하면 Python 프로그램 설정으로 연결됩니다.</p></details>;
}
