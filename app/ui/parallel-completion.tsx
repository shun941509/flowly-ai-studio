"use client";
import { useState } from "react";
import type { ParallelConfig } from "../../runtime/types";
import { parsePredicate } from "../../domain/predicate";

export function ParallelCompletionSettings({ value, onChange }: { value?: ParallelConfig["completion"]; onChange: (value: ParallelConfig["completion"]) => void }) {
  const [draft, setDraft] = useState(JSON.stringify(value?.checks ?? [{ path: "data.sufficient", operator: "eq", value: true }], null, 2));
  const [error, setError] = useState("");
  return <><label className="field-label">결과 수집 방식<select value={value ? "first_match" : "all"} onChange={event => { setError(""); onChange(event.target.value === "all" ? undefined : { mode: "first_match", checks: [{ path: "data.sufficient", operator: "eq", value: true }] }); }}><option value="all">모든 작업이 끝날 때까지 기다리기</option><option value="first_match">조건을 먼저 충족한 결과 선택</option></select></label>{value && <><label className="field-label">최종 결과의 완료 조건 (JSON 배열)<textarea value={draft} rows={6} maxLength={10000} onChange={event => setDraft(event.target.value)} /></label><button type="button" className="btn secondary" onClick={() => { try { const raw: unknown = JSON.parse(draft); if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw Error("완료 조건은 1~20개가 필요해요."); onChange({ mode: "first_match", checks: raw.map(parsePredicate) }); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "완료 조건을 확인해 주세요."); } }}>완료 조건 적용</button><p className="field-help">각 하위 흐름의 출력 블록에 연결된 값을 검사해요. 먼저 충족한 결과를 저장하고 미완료 작업과 대기 승인을 취소합니다. 이미 완료된 변경은 유지되며, 실행 중인 변경의 결과가 불명확하면 확인 필요 상태로 멈춰요.</p>{error && <p className="form-error" role="alert">{error}</p>}</>}</>;
}
