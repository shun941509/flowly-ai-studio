"use client";
/**
 * 기획 예제와 도구 후보의 대응표 UI. 공통 실행 계약 지원·개별 흐름 구현·실제 서비스 설정을 구별하는 설명을 제공한다.
 */

import { useMemo, useState } from 'react';
import { PLANNED_EXAMPLES, TOOL_FAMILIES, getToolsForExample } from '../../domain/tool-catalog';

/** 대응표를 검색하고 실제 소스 예제로 이동시킨다. 추천 도구 목록을 Agent의 허용 목록에 자동 추가하지 않는다. */
export function PlannedExamples({ onOpen }: { onOpen: (sourceId: string) => void }) {
  const [query,setQuery]=useState('');
  const [family,setFamily]=useState('');
  const [limit,setLimit]=useState(12);
  const examples=useMemo(()=>PLANNED_EXAMPLES.filter(example=>(!family||example.families.includes(family))&&`${example.id} ${example.title} ${example.requirement} ${example.toolIds.join(' ')}`.toLowerCase().includes(query.toLowerCase())),[query,family]);
  return <section aria-label="기획 100개와 도구 연결표">
    <p className="catalog-starter-note">기획 100개와 도구화 후보 195개의 연결표입니다. 각 기획에서 실행 구조·확인할 결과·사용자 설정을 볼 수 있어요. 구현 상태는 로컬 실행 계약의 범위이며, 실제 모델의 답변 품질과 회사 서비스 연결은 사용자가 확인해야 합니다. 후보 도구는 추천 목록이며 Agent에 자동 허용되지 않습니다.</p>
    <div className="catalog-filters"><label className="search-field">기획·도구 검색<input value={query} placeholder="예: 057, Graph, bm25" onChange={event=>{setQuery(event.target.value);setLimit(12);}}/></label><label><span>필요 기능</span><select value={family} onChange={event=>{setFamily(event.target.value);setLimit(12);}}><option value="">모든 기능군</option>{TOOL_FAMILIES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    <p role="status">{examples.length}개 기획 · {PLANNED_EXAMPLES.filter(item=>item.status==='구현됨').length}개 실행 계약 구현 · {PLANNED_EXAMPLES.filter(item=>item.integrationStatus==='acceptance_implemented').length}개 고유 흐름 추가·보강</p>
    <div className="catalog-grid">{examples.slice(0,limit).map(example=><article className="catalog-card" key={example.id}>
      <div className="catalog-card-top"><span className="catalog-category">기획 {example.id}</span><span className="catalog-setup">{example.status}</span></div>
      <h2>{example.title}</h2><p>{example.requirement}</p><p><strong>현재 실행 범위: </strong>{example.integrationScope}</p>
      <div className="catalog-node-types">{example.families.map(id=><span key={id}>{TOOL_FAMILIES.find(item=>item.id===id)?.name}</span>)}</div>
      {example.acceptance?.length ? <details><summary>확인할 실행 결과 {example.acceptance.length}개</summary><ul>{example.acceptance.map(item=><li key={item}>{item}</li>)}</ul></details> : null}
      {example.remainingSetup?.length ? <details><summary>내보낸 뒤 설정할 항목</summary><ul>{example.remainingSetup.map(item=><li key={item}>{item}</li>)}</ul></details> : null}
      <details><summary>연결 가능한 도구 {example.toolIds.length}개</summary><p>{getToolsForExample(example.id).map(tool=>tool.name).join(' · ')}</p></details>
      {example.sourceIds.length>0?<div className="catalog-graph-tools">{example.sourceIds.map((id,index)=><button key={id} type="button" className="btn secondary" onClick={()=>onOpen(id)}>{index===0?'실제 연결 구조 보기':`관련 소스 ${index+1}`}</button>)}</div>:<p className="field-help">직접 대응하는 실행 프로젝트는 아직 없습니다. 공통 도구 지원과 업무 워크플로 완료는 별개입니다.</p>}
    </article>)}</div>
    {examples.length>limit&&<button type="button" className="btn secondary" onClick={()=>setLimit(limit+12)}>기획 더 보기</button>}
  </section>;
}
