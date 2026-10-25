"use client";
import type { FlowNode } from "../lib/model";
import type { PredicateConfig } from "../../runtime/types";

export function PredicateSettings({ node, onChange }: { node: FlowNode; onChange: (node: FlowNode) => void }) {
  const p = node.predicate;
  const update = (next: PredicateConfig) => onChange({ ...node, predicate: next });
  const valueType = p?.value === null ? "null" : typeof p?.value;
  return <>
    <label className="field-label">비교 방식<select value={p ? "value" : "text"} onChange={e => {
      const copy = { ...node }; if (e.target.value === "text") delete copy.predicate;
      else copy.predicate = { path: "data.amount", operator: "gte", value: 0 };
      // Migration-created text schemas must not reject a value-only condition.
      const standard = JSON.stringify(copy.outputSchema);
      if (!copy.outputSchema || standard === JSON.stringify({type:"object",properties:{text:{type:"string"}},required:["text"]}) || standard === JSON.stringify({type:"object",properties:{matched:{type:"boolean"}},required:["matched"]})) {
        copy.outputSchema = copy.predicate ? {type:"object",properties:{matched:{type:"boolean"}},required:["matched"]} : {type:"object",properties:{text:{type:"string"}},required:["text"]};
      }
      onChange(copy);
    }}><option value="text">문장에 단어 포함</option><option value="value">숫자·값 직접 비교</option></select></label>
    {!p ? <label className="field-label">앞 단계 text에 포함할 단어<textarea rows={3} value={node.condition || ""} onChange={e => onChange({ ...node, condition: e.target.value })} maxLength={200}/></label> : <>
      <label className="field-label">비교할 값의 경로<input value={p.path} onChange={e => update({ ...p, path: e.target.value })} placeholder="data.amount"/></label>
      <label className="field-label">비교 조건<select value={p.operator} onChange={e => update({ ...p, operator: e.target.value as PredicateConfig["operator"] })}>{Object.entries({ eq: "같음", ne: "다름", gt: "초과", gte: "이상", lt: "미만", lte: "이하", contains: "글자 포함 (대소문자 구분)" }).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
      <label className="field-label">비교 대상<select value={p.rightPath === undefined ? "literal" : "field"} onChange={e => update(e.target.value === "field" ? { path: p.path, operator: p.operator, rightPath: "data.limit" } : { path: p.path, operator: p.operator, value: 0 })}><option value="literal">직접 입력한 값</option><option value="field">다른 값의 경로</option></select></label>
      {p.rightPath !== undefined ? <label className="field-label">대상 경로<input value={p.rightPath} onChange={e => update({ ...p, rightPath: e.target.value })}/></label> : <>
        <label className="field-label">값 종류<select value={valueType} onChange={e => update({ ...p, value: e.target.value === "number" ? 0 : e.target.value === "boolean" ? true : e.target.value === "null" ? null : "" })}><option value="number">숫자</option><option value="string">글자</option><option value="boolean">참/거짓</option><option value="null">비어 있음 (null)</option></select></label>
        {valueType === "boolean" ? <label className="field-label">비교 값<select value={String(p.value)} onChange={e => update({ ...p, value: e.target.value === "true" })}><option value="true">참</option><option value="false">거짓</option></select></label> : valueType !== "null" && <label className="field-label">비교 값<input type={valueType === "number" ? "number" : "text"} value={String(p.value ?? "")} onChange={e => update({ ...p, value: valueType === "number" ? Number(e.target.value) : e.target.value })}/></label>}
      </>}
      <p className="field-help">아래 ‘전달받을 내용’에 연결한 값을 비교해요. 누락된 값과 잘못된 숫자 자료형은 실행 오류로 중단합니다.</p>
    </>}
  </>;
}
