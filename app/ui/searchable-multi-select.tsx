"use client";
import { useId, useState } from "react";
import { Modal } from "./common";

export type MultiSelectOption = { id: string; label: string; description?: string; category?: string; disabled?: boolean; reason?: string };
export type MultiSelectProps = { label: string; options: MultiSelectOption[]; value: string[]; onChange: (ids: string[]) => void; maxSelected?: number; disabled?: boolean };

/** 검색은 표시 목록만 바꾸며 선택 ID는 보존한다. 사라진 자료도 명시적으로 해제하기 전까지 선택 상태에 남긴다. */
export function SearchableMultiSelect(props: MultiSelectProps) {
  const [expanded, setExpanded] = useState(false);
  return <><SelectionList {...props} onExpand={() => setExpanded(true)} />{expanded && <Modal size="editor" title={props.label} onClose={() => setExpanded(false)}><div className="modal-body"><SelectionList {...props} /></div><footer className="modal-footer"><button type="button" className="btn primary" onClick={() => setExpanded(false)}>선택 완료</button></footer></Modal>}</>;
}

function SelectionList({ label, options, value, onChange, maxSelected, disabled, onExpand }: MultiSelectProps & { onExpand?: () => void }) {
  const [query, setQuery] = useState(""), [category, setCategory] = useState(""), [selectedOnly, setSelectedOnly] = useState(false);
  const id = useId(), categories = [...new Set(options.map(option => option.category).filter(Boolean))];
  const missing = value.filter(key => !options.some(option => option.id === key));
  const visible = options.filter(option => (!selectedOnly || value.includes(option.id)) && (!category || option.category === category) && `${option.label} ${option.description ?? ""} ${option.id}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="multi-select" aria-labelledby={`${id}-label`}><div className="multi-select-heading"><strong id={`${id}-label`}>{label}</strong><span>{value.length}{maxSelected !== undefined ? ` / ${maxSelected}` : ""}개 선택</span>{onExpand && <button type="button" className="text-btn" onClick={onExpand}>크게 선택</button>}</div>
    <div className="multi-select-filters"><input aria-label={`${label} 검색`} placeholder="이름·설명으로 검색" value={query} onChange={event => setQuery(event.target.value)} />{categories.length > 1 && <select aria-label={`${label} 종류`} value={category} onChange={event => setCategory(event.target.value)}><option value="">모든 종류</option>{categories.map(item => <option key={item} value={item}>{item}</option>)}</select>}</div>
    <label className="inline-check"><input type="checkbox" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)} /><span>선택한 항목만 보기</span></label>
    <div className="multi-select-options">{visible.map(option => { const checked = value.includes(option.id); return <label className={`multi-select-option ${option.disabled ? "unavailable" : ""}`} key={option.id}><input type="checkbox" checked={checked} disabled={disabled || (!checked && (option.disabled || maxSelected !== undefined && value.length >= maxSelected))} onChange={event => onChange(event.target.checked ? [...value, option.id] : value.filter(key => key !== option.id))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}{option.reason && <small>{option.reason}</small>}</span></label>; })}{!visible.length && <p className="field-help">검색 조건에 맞는 항목이 없어요. 선택한 항목은 유지됩니다.</p>}</div>
    {missing.length > 0 && <div className="multi-select-missing"><strong>현재 목록에서 확인할 수 없는 선택</strong>{missing.map(key => <div key={key}><span>{key} · 삭제 또는 권한 변경 여부를 확인하고 다른 항목을 선택하세요.</span><button type="button" disabled={disabled} className="text-btn" onClick={() => onChange(value.filter(item => item !== key))}>해제</button></div>)}</div>}
  </section>;
}
