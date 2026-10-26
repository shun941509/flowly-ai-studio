"use client";
/**
 * 루트와 하위 설계의 사전 검사 오류를 실제 편집 위치로 연결하는 UI. 그래프·자료 정의를 읽는 검사이며 외부 AI를 호출하지 않는다.
 */

import { useMemo } from 'react';
import { inspectWorkflow } from '../../domain/preflight';
import { childDefinitions } from '../../domain/advanced-config';
import type { NestedStep } from '../../domain/nested-editing';
import type { Definition, Resource, Workflow } from '../lib/model';
import type { RuntimeCapabilities } from '../../runtime/types';
import { requestNestedInspection, useEditorComposition } from './editor-composition-context';
/** 모든 하위 설계를 검사하고 같은 오류가 부모와 자식에 중복되면 더 구체적인 하위 위치를 남긴다. */
export function diagnosticLocations(workflow:Workflow,resources:Resource[],capabilities?:RuntimeCapabilities|null){
 const result:{message:string;nodeId?:string;path:NestedStep[];label:string}[]=[];
 function visit(definition:Definition,path:NestedStep[],labels:string[]){
  for(const issue of inspectWorkflow({...workflow,definition},resources,capabilities).issues.filter(item=>item.severity==='error'))result.push({...issue,path,label:labels.join(' / ')});
  for(const node of definition.nodes)childDefinitions(node).forEach((child,childIndex)=>visit(child,[...path,{nodeId:node.id,childIndex}],[...labels,node.title,`하위 ${childIndex+1}`]));
 }
 visit(workflow.definition,[],[]);
 return result.filter(item=>!result.some(other=>other.message===item.message&&other.path.length>item.path.length&&item.path.every((step,i)=>JSON.stringify(step)===JSON.stringify(other.path[i]))));
}
/** 오류 선택 시 최상위 블록을 먼저 연 뒤 중첩 경로 탐색을 요청한다. 오류 메시지와 이동 위치를 함께 유지한다. */
export function EditorDiagnostics({workflow,resources,capabilities,onInspect}:{workflow:Workflow;resources:Resource[];capabilities?:RuntimeCapabilities|null;onInspect:(nodeId:string)=>void}){
 const composition=useEditorComposition();
 const issues=useMemo(()=>diagnosticLocations(workflow,resources,capabilities),[workflow,resources,capabilities]);
 if(!issues.length)return null;
 return <details className="editor-diagnostics"><summary>{issues.length}개 설정·연결 확인 — 항목을 눌러 실제 블록으로 이동</summary><ul>{issues.map((issue,index)=><li key={`${issue.nodeId}:${index}`}>{issue.nodeId?<button type="button" onClick={()=>{onInspect(issue.path[0]?.nodeId??issue.nodeId!);requestNestedInspection({workflowId:composition?.workflowId??workflow.id,path:[...(composition?.locationPath??[]),...issue.path],nodeId:issue.nodeId!,message:issue.message});}}>{issue.label&&<strong>{issue.label} / </strong>}{issue.message}<span>{issue.path.length?'하위 흐름의 실제 블록 열기':'블록 설정 열기'} →</span></button>:<p>{issue.label} {issue.message}</p>}</li>)}</ul></details>;
}
