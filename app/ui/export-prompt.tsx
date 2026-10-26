"use client";
/**
 * 생성된 AI 작업 지시를 읽고 복사하는 화면. 짧은 시작 지시·전체 원문·분할 전달을 구분하며 외부 AI 실행은 시작하지 않는다.
 */


import { useMemo, useRef, useState } from "react";
import { copyExportPrompt, exportPromptCharacterCount, exportPromptPart, splitExportPrompt } from "../lib/export-client";

/** 긴 지시를 원문 손실 없이 나눠 보여준다. 현재 조각 선택과 전체 복사 동작을 분리하고 클립보드 실패 시 수동 선택을 안내한다. */
export function PromptPreview({ text, kickoff }: { text: string; kickoff?: string }) {
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
    {kickoff&&<div className="settings-card"><h4>짧은 시작 지시 · 프로젝트와 함께 전달</h4><textarea aria-label="짧은 시작 지시" readOnly rows={4} value={kickoff}/><button type="button" className="btn secondary" onClick={async()=>{try{await navigator.clipboard.writeText(kickoff);setNotice("짧은 시작 지시를 복사했어요. Agent 다운로드 폴더도 함께 전달하세요.");}catch{setNotice("복사할 수 없어 짧은 시작 지시를 직접 선택해 복사해 주세요.");}}}>시작 지시 복사</button><p className="field-help">아래 전체 상세 지시는 노드·연결·선택 자료까지 포함해요. Cowork·Codex의 파일 접근과 실행 기능은 사용자가 준비합니다.</p></div>}
    <p className="field-help">설계·노드 연결·선택 자료·설정 위치를 함께 복사해요. 외부 AI에게 실제 업무를 요청할 때 전달하세요. 파일 다운로드는 제공하지 않아요.</p>
    <p className="field-help">전체 {characters.toLocaleString("ko-KR")}자 · 내용 생략 없음. 글자 수는 모델의 토큰 수가 아니며, 외부 AI의 전체 입력 한도는 별도로 확인해야 해요.</p>
    {parts.length>1&&<div className="settings-card"><label>긴 프롬프트 전달 방식 <select aria-label="복사할 프롬프트 범위" value={activePart} onChange={event=>{setPart(Number(event.target.value));setNotice("");}}><option value={-1}>전체 내용</option>{parts.map((_,index)=><option key={index} value={index}>{index+1}/{parts.length} 조각</option>)}</select></label><p className="field-help">조각은 원문을 자르거나 요약하지 않고 나눠 전달해요. 모두 번호순으로 보낸 뒤 실행하세요. 나눠 보내도 외부 AI의 전체 입력 한도가 늘어나지는 않아요.</p></div>}
    <textarea ref={field} className="export-prompt-text" aria-label="복사할 AI 명령 프롬프트" readOnly value={displayed} rows={14}/>
    <div className="export-prompt-actions"><button type="button" className="btn primary" onClick={()=>void copy()}>{activePart>=0?"전체 프롬프트 복사":"프롬프트 복사"}</button><button type="button" className="btn secondary" onClick={()=>{selectAll();setNotice("전체 텍스트를 선택했어요.");}}>전체 텍스트 선택</button>{activePart>=0&&<button type="button" className="btn secondary" onClick={()=>void copyPart()}>{activePart+1}/{parts.length} 조각 복사</button>}</div>
    {notice&&<p className="field-help" role="status">{notice}</p>}
  </section>;
}
