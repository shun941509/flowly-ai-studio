"use client";
import { useTextDraft } from "./control-fields";
/**
 * 병렬 작업의 전체 대기/첫 조건 충족 결과 수집 정책 UI. 완료 조건 JSON은 적용 시 predicate 계약으로 검사한다.
 */

import { useState } from "react";
import type { ParallelConfig } from "../../runtime/types";
import { parsePredicate } from "../../domain/predicate";

/** completion이 없으면 모든 작업을 수집한다. 먼저 충족한 결과 선택 설정은 런타임의 취소 정책을 지정하며 UI가 진행 중 작업을 직접 취소하지 않는다. */
export function ParallelCompletionSettings({ value, onChange }: { value?: ParallelConfig["completion"]; onChange: (value: ParallelConfig["completion"]) => void }) {
  const {draft,setDraft,reset,stale}=useTextDraft(JSON.stringify(value?.checks??[{path:"data.sufficient",operator:"eq",value:true}],null,2));
  const [error, setError] = useState("");
  return <>{stale&&<p className="draft-stale">적용 조건이 바뀌었지만 JSON 초안을 유지했습니다.</p>}<label className="field-label">결과 수집 방식<select value={value ? "first_match" : "all"} onChange={event => { setError(""); onChange(event.target.value === "all" ? undefined : { mode: "first_match", checks: [{ path: "data.sufficient", operator: "eq", value: true }] }); }}><option value="all">모든 작업이 끝날 때까지 기다리기</option><option value="first_match">조건을 먼저 충족한 결과 선택</option></select></label>{value && <><button type="button" className="text-btn" onClick={reset}>최신 적용 조건으로 되돌리기</button><label className="field-label">최종 결과의 완료 조건 (JSON 배열)<textarea value={draft} rows={6} maxLength={10000} onChange={event => setDraft(event.target.value)} /></label><button type="button" className="btn secondary" onClick={() => { try { const raw: unknown = JSON.parse(draft); if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw Error("완료 조건은 1~20개가 필요해요."); onChange({ mode: "first_match", checks: raw.map(parsePredicate) }); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "완료 조건을 확인해 주세요."); } }}>완료 조건 적용</button><p className="field-help">각 하위 흐름의 출력 블록에 연결된 값을 검사해요. 먼저 충족한 결과를 저장하고 미완료 작업과 대기 승인을 취소합니다. 이미 완료된 변경은 유지되며, 실행 중인 변경의 결과가 불명확하면 확인 필요 상태로 멈춰요.</p>{error && <p className="form-error" role="alert">{error}</p>}</>}</>;
}
