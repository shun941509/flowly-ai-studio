"use client";
import { useState } from "react";
import { Modal } from "./common";

export type TextDraft = { base: string; text: string };
/** 적용값 갱신/실행 취소를 만나도 미적용 초안을 보존한다. 현재 초안이 이미 적용된 경우에는 새 기준으로 인정한다. */
export function reconcileTextDraft(current: TextDraft, applied: string): TextDraft {
  return current.base !== applied && (current.text === current.base || current.text === applied) ? { base: applied, text: applied } : current;
}

/** 서버/되돌리기로 적용값이 달라져도 미적용 문자열은 보존한다. 사용자가 되돌리기를 선택하면 최신 적용값으로 맞춘다. */
export function useTextDraft(value: string) {
  const [state, setState] = useState({ base: value, text: value });
  const dirty = state.text !== state.base;
  const next = reconcileTextDraft(state, value);
  if (next !== state) setState(next);
  return { draft: !dirty && state.base !== value ? value : state.text, dirty, stale: dirty && state.base !== value && state.text !== value,
    setDraft: (text: string) => setState(current => ({ ...current, text })), reset: () => setState({ base: value, text: value }),
    applied: (text: string) => setState({ base: text, text }) };
}

/** 입력 중 빈칸과 미완성 숫자를 허용하고 blur/Enter에서만 저장 가능한 범위를 검사한다. */
export function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  const field = useTextDraft(String(value)), [error, setError] = useState("");
  function commit() { const parsed = Number(field.draft); if (!field.draft.trim() || !Number.isFinite(parsed) || parsed < min || parsed > max || step === 1 && !Number.isInteger(parsed)) { setError(`${min}~${max} 범위${step === 1 ? "의 정수" : ""}로 입력해 주세요.`); return; } onChange(parsed); field.applied(String(parsed)); setError(""); }
  return <label className="field-label">{label}<input type="number" min={min} max={max} step={step} value={field.draft} onChange={event => { field.setDraft(event.target.value); setError(""); }} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} aria-invalid={Boolean(error)} /><small className={error ? "form-error" : "field-help"}>{error || `${min.toLocaleString()}~${max.toLocaleString()} · 입력 후 다른 항목을 선택하면 적용돼요.`}</small></label>;
}

/** 큰 편집 창을 닫을 때도 입력은 부모 노드에 보존된다. 별도 AI 생성이나 자동 치환은 하지 않는다. */
export function PromptField({ label, value, onChange, maxLength = 12000 }: { label: string; value: string; onChange: (value: string) => void; maxLength?: number }) {
  const [open, setOpen] = useState(false);
  return <><label className="field-label">{label}<textarea rows={5} maxLength={maxLength} value={value} onChange={event => onChange(event.target.value)} /></label><div className="prompt-actions"><span>{value.length.toLocaleString()} / {maxLength.toLocaleString()}자</span><button type="button" className="text-btn" onClick={() => setOpen(true)}>크게 편집하기</button></div>{open && <Modal title={label} size="editor" onClose={() => setOpen(false)}><div className="modal-body"><label className="field-label">{label}<textarea className="expanded-prompt" rows={18} maxLength={maxLength} value={value} onChange={event => onChange(event.target.value)} /></label><p className="field-help">입력은 현재 블록에 반영됩니다. 워크플로 저장은 별도로 진행하세요.</p></div><footer className="modal-footer"><button type="button" className="btn primary" onClick={() => setOpen(false)}>편집 완료</button></footer></Modal>}</>;
}
