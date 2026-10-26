"use client";
/**
 * 공통 용어 사전과 설계 설명을 읽는 가이드 화면. 편집 중 도움말은 별도 모달로 열어 기존 문서 상태를 유지한다.
 */

import { useState } from 'react';
import type { Definition, NodeType } from '../lib/model';
import { explainWorkflow, guideTerms, blockGuides } from '../../domain/workflow-guide';
import { Icon, Modal } from './common';

const firstSteps = [
 {title:'예제 고르기',body:'무엇을 하는지, 준비할 자료와 받을 결과를 확인하세요. 복제하면 내 비공개 사본과 샘플 자료가 만들어집니다.',href:'#templates',link:'예제 프로젝트 보기',icon:'templates'},
 {title:'내 일에 맞추기',body:'목표 → 자료 → 역할 → 결과 → 완료 조건을 바꾸세요. 실제 작업 지시는 Agent의 목표와 지침에서 설정합니다.',href:'#editor',link:'워크플로 만들기',icon:'workflow'},
 {title:'연결과 분기 확인',body:'입력 연결과 오류 안내를 확인하세요. 미리보기는 설계 구조를 점검하며 실제 AI 답변을 생성하지 않습니다.',term:'mapping',link:'입출력 연결 알아보기',icon:'branch'},
 {title:'공유 범위 정하기',body:'누가 읽고 수정할 수 있는지 선택하세요. 워크플로를 공유해도 연결된 자료의 권한과 자격 증명은 별도로 유지됩니다.',href:'#workflows',link:'내 워크플로 보기',icon:'users'},
 {title:'외부 AI와 실행하기',body:'AI 명령 프롬프트를 복사하거나 프로젝트를 내려받으세요. Cowork·Codex에 START_HERE.md를 먼저 읽도록 요청하고 내 PC에 연결 설정을 등록합니다.',term:'export',link:'내보내기 알아보기',icon:'download'},
 {title:'수정본 다시 가져오기',body:'외부 AI가 바꾼 workflow.json이나 ZIP을 가져와 원본과 비교하세요. 자료를 재연결하고 새 사본 또는 새 버전으로 저장합니다.',href:'#workflows',link:'내 워크플로에서 가져오기',icon:'upload'},
] as const;

/** 시작 안내·용어·문제 해결을 같은 콘텐츠에서 제공한다. 특정 용어로 열면 용어 탭을 먼저 표시한다. */
export function WorkflowGuide({term,block,onClose}:{term?:string;block?:NodeType;onClose?:()=>void}){
 const [section,setSection]=useState(block?'blocks':term?'terms':'start'),[query,setQuery]=useState(''),[selectedTerm,setSelectedTerm]=useState(term);
 const filtered=guideTerms.filter(item=>`${item.name} ${item.meaning}`.toLowerCase().includes(query.toLowerCase()));
 const content=<div className={`workflow-guide ${onClose?"modal-body":""}`}>{!onClose&&<header className="page-heading"><div><span className="eyebrow">GET STARTED</span><h1>시작 가이드</h1><p>처음 설계할 때부터 외부 AI와 실행할 때까지, 필요한 내용을 찾아보세요.</p></div></header>}<nav aria-label="가이드 구성">{[['start','처음 시작하기'],['terms','핵심 용어'],['blocks','블록 가이드'],['help','사용 방법과 문제 해결']].map(([id,label])=><button type="button" aria-pressed={section===id} className={section===id?'btn primary':'btn secondary'} key={id} onClick={()=>setSection(id)}>{label}</button>)}</nav>
 {section==='start'&&<section><div className="guide-section-heading"><h2>사람이 일하는 순서를 설계하세요</h2><p>예제로 시작하고, 필요한 부분부터 내 작업에 맞게 바꾸면 됩니다.</p></div><ol className="guide-start-steps">{firstSteps.map((step,index)=><li key={step.title}><div className="guide-step-heading"><span className="guide-step-number">{index+1}</span><Icon name={step.icon} size={19}/><h3>{step.title}</h3></div><p>{step.body}</p>{'href' in step?<a className="text-btn" href={step.href} onClick={onClose}>{step.link}<Icon name="arrowRight" size={14}/></a>:<button type="button" className="text-btn" onClick={()=>{setSelectedTerm(step.term);setQuery('');setSection('terms');}}>{step.link}<Icon name="arrowRight" size={14}/></button>}</li>)}</ol><div className="guide-boundary-note"><Icon name="info" size={18}/><p>웹은 설계·자료 관리·검사·미리보기·내보내기를 담당합니다. OpenAI를 호출하거나 API 키를 받지 않으며, 실제 모델·MCP 설정은 내려받은 실행 환경에서 등록합니다.</p></div></section>}
 {section==='terms'&&<section><div className="guide-section-heading"><h2>핵심 용어</h2><p>뜻·사용 상황·설정 위치·예시와 현재 지원 범위를 함께 확인하세요.</p></div><label className="field-label">용어 찾기<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Agent, MCP, RAG, 입력 연결"/></label>{filtered.sort((a,b)=>Number(b.id===selectedTerm)-Number(a.id===selectedTerm)).map(item=><details key={item.id} open={item.id===selectedTerm||!!query}><summary>{item.name}</summary><p>{item.meaning}</p><dl><dt>언제 사용하나요?</dt><dd>{item.when}</dd><dt>어디서 설정하나요?</dt><dd>{item.where}</dd><dt>예시</dt><dd>{item.example}</dd><dt>비슷한 개념과의 차이</dt><dd>{item.difference}</dd><dt>현재 지원 범위</dt><dd>{item.support}</dd></dl></details>)}{!filtered.length&&<p>일치하는 용어가 없어요. 짧은 단어로 다시 찾아보세요.</p>}</section>}
 {section==='blocks'&&<section className="block-guide-list"><h2>블록 가이드</h2><p>블록의 입력·결과·설정 위치를 확인하세요. 예시 값은 실제 실행 결과가 아닙니다.</p><label className="field-label">블록 찾기<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Agent, 병렬, 문서 검색"/></label>{blockGuides.filter(item=>(item.name+' '+item.type+' '+item.meaning).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>Number(b.type===block)-Number(a.type===block)).map(item=><details key={item.type} open={item.type===block||Boolean(query)}><summary>{item.name}</summary><p>{item.meaning}</p><dl><dt>언제 사용하나요?</dt><dd>{item.when}</dd><dt>필요한 입력</dt><dd>{item.input}</dd><dt>받을 결과</dt><dd>{item.output}</dd><dt>설정 위치</dt><dd>{item.where}</dd><dt>설명용 예시</dt><dd>{item.example}</dd><dt>차이와 지원 범위</dt><dd>{item.support}</dd></dl></details>)}</section>}
 {section==='help'&&<section><h2>사용 방법과 문제 해결</h2>{[['값이 전달되지 않아요','선을 이은 뒤 입력 연결에서 앞 단계와 결과 항목을 선택하세요. 조건에서 건너뛴 경로는 값을 만들지 않습니다. 필수 항목에는 항상 실행되는 경로의 값을 연결하거나 분기별 처리를 나누세요.'],['빈 결과가 나와요','항목이 없는 것과 빈 문자열·빈 목록은 다릅니다. 검색 근거가 없거나 목록이 비었을 때 조건·평가 블록으로 다른 경로를 연결하세요. 예시 값은 실제 응답이 아닙니다.'],['하위 흐름 오류를 찾고 싶어요','오류 안내의 블록 열기를 누르면 해당 하위 흐름까지 이동합니다. 화면 편집 내용과 JSON 초안은 상위 적용 전까지 별도로 보관됩니다.'],['설정 필요·권한 없음·실행 실패는 무엇인가요?','설정 필요는 내보낸 환경의 모델·MCP 설정 확인, 권한 없음은 소유자의 공유 상태 확인, 실행 실패는 로컬 실행 기록의 오류 원인과 다음 행동 확인이 필요합니다.'],['저장이 충돌했어요','다른 사용자가 먼저 저장했을 수 있습니다. 최신 저장본과 비교하고 내 편집을 사본으로 보존하세요. 자동 덮어쓰지 않습니다.'],['다운로드에 Agent가 꼭 필요한가요?','아니요. Agent 없는 계산·도구 흐름도 내려받을 수 있으며 가짜 Agent를 자동 추가하지 않습니다. 설계 오류와 자료 권한은 별도로 검사합니다.'],['중지·재개·새 실행은 어떻게 다른가요?','재개는 저장된 상태에서 이어가고 새 실행은 새 기록으로 처음 시작합니다. 승인·보완 입력을 제출한 뒤 재개하세요. 설계가 달라졌다면 새 실행을 시작하세요.'],['외부 AI 수정 코드가 캔버스에 안 보여요','workflow.json의 설계 변경만 검증하여 가져옵니다. 실행기 코드 수정은 별도 변경이며 자동으로 노드로 변환하지 않습니다. 문서 갱신과 파일 일치 검사를 다시 수행하세요.']].map(([title,body])=><details key={title}><summary>{title}</summary><p>{body}</p></details>)}</section>}
 </div>;
 return onClose?<Modal title="Flowly 가이드" size="guide" onClose={onClose}>{content}</Modal>:content;
}
/** 현재 화면을 이동시키지 않고 가이드를 겹쳐 연다. 닫을 때 부모 편집기의 상태를 다시 만들지 않는다. */
export function GuideHelp({term,block,label='가이드에서 알아보기'}:{term:string;block?:NodeType;label?:string}){const [open,setOpen]=useState(false);return <><button type="button" className="text-btn guide-help" onClick={()=>setOpen(true)}>{label}</button>{open&&<WorkflowGuide term={term} block={block} onClose={()=>setOpen(false)}/>}</>;}
/** 그래프의 연결과 분기 규칙으로 문장 설명을 만든다. 생성형 모델의 판단이나 실제 실행 결과가 아니다. */
export function WorkflowExplanation({definition}:{definition:Definition}){return <details className="workflow-explanation"><summary>이 설계의 실행 순서·분기·실패 경로를 글로 보기</summary><p>현재 연결과 규칙을 설명합니다. 실제 실행 결과나 AI 판단은 아닙니다.</p><ol>{explainWorkflow(definition).map((line,index)=><li key={index}>{line}</li>)}</ol></details>;}
