"use client";

import { useMemo, useRef, useState } from "react";
import { copyExportPrompt, exportPromptCharacterCount, exportPromptPart, splitExportPrompt } from "../lib/export-client";

export function PromptPreview({ text }: { text: string }) {
  const field=useRef<HTMLTextAreaElement>(null);
  const [notice,setNotice]=useState("");
  const [part,setPart]=useState(-1);
  const parts=useMemo(()=>splitExportPrompt(text),[text]);
  const characters=useMemo(()=>exportPromptCharacterCount(text),[text]);
  const activePart=part>=0&&part<parts.length?part:-1;
  const displayed=activePart<0?text:exportPromptPart(parts,activePart);
  const select=()=>{field.current?.focus();field.current?.select();};
  const selectAll=()=>{setPart(-1);requestAnimationFrame(select);};
  async function copy(){const result=await copyExportPrompt(text,navigator.clipboard,selectAll);setNotice(result==="copied"?"AI 명령 프롬프트 전체를 복사했어요.":"클립보드를 사용할 수 없어 전체 텍스트를 선택했어요. Ctrl+C 또는 복사 메뉴를 사용하세요.");}
  async function copyPart(){const selected=activePart;const result=await copyExportPrompt(displayed,navigator.clipboard,()=>{setPart(selected);requestAnimationFrame(select);});setNotice(result==="copied"?`${selected+1}/${parts.length} 조각을 복사했어요. 번호순으로 모두 전달한 뒤 실행하세요.`:"표시된 조각을 선택했어요. Ctrl+C 또는 복사 메뉴를 사용하세요.");}
  return <section className="export-prompt-preview" aria-label="AI 명령 프롬프트 미리보기">
    <h3>AI 명령 프롬프트</h3>
    <p className="field-help">설계·노드 연결·선택 자료·설정 위치를 함께 복사해요. 외부 AI에게 실제 업무를 요청할 때 전달하세요. 파일 다운로드는 제공하지 않아요.</p>
    <p className="field-help">전체 {characters.toLocaleString("ko-KR")}자 · 내용 생략 없음. 글자 수는 모델의 토큰 수가 아니며, 외부 AI의 전체 입력 한도는 별도로 확인해야 해요.</p>
    {parts.length>1&&<div className="settings-card"><label>긴 프롬프트 전달 방식 <select aria-label="복사할 프롬프트 범위" value={activePart} onChange={event=>{setPart(Number(event.target.value));setNotice("");}}><option value={-1}>전체 내용</option>{parts.map((_,index)=><option key={index} value={index}>{index+1}/{parts.length} 조각</option>)}</select></label><p className="field-help">조각은 원문을 자르거나 요약하지 않고 나눠 전달해요. 모두 번호순으로 보낸 뒤 실행하세요. 나눠 보내도 외부 AI의 전체 입력 한도가 늘어나지는 않아요.</p></div>}
    <textarea ref={field} className="export-prompt-text" aria-label="복사할 AI 명령 프롬프트" readOnly value={displayed} rows={14}/>
    <div className="export-prompt-actions"><button type="button" className="btn primary" onClick={()=>void copy()}>{activePart>=0?"전체 프롬프트 복사":"프롬프트 복사"}</button><button type="button" className="btn secondary" onClick={()=>{selectAll();setNotice("전체 텍스트를 선택했어요.");}}>전체 텍스트 선택</button>{activePart>=0&&<button type="button" className="btn secondary" onClick={()=>void copyPart()}>{activePart+1}/{parts.length} 조각 복사</button>}</div>
    {notice&&<p className="field-help" role="status">{notice}</p>}
  </section>;
}
