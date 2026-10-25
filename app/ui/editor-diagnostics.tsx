"use client";
import { useMemo } from 'react';
import { inspectWorkflow } from '../../domain/preflight';
import type { Resource, Workflow } from '../lib/model';
import type { RuntimeCapabilities } from '../../runtime/types';
export function EditorDiagnostics({workflow,resources,capabilities,onInspect}:{workflow:Workflow;resources:Resource[];capabilities?:RuntimeCapabilities|null;onInspect:(nodeId:string)=>void}){
 const issues=useMemo(()=>inspectWorkflow(workflow,resources,capabilities).issues.filter(issue=>issue.severity==='error'),[workflow,resources,capabilities]);
 if(!issues.length)return null;
 return <details className="editor-diagnostics"><summary>{issues.length}개 설정·연결 확인 — 항목을 눌러 블록으로 이동</summary><ul>{issues.map((issue,index)=><li key={`${issue.nodeId}:${index}`}>{issue.nodeId?<button type="button" onClick={()=>onInspect(issue.nodeId!)}>{issue.message}<span>블록 설정 열기 →</span></button>:<p>{issue.message}</p>}</li>)}</ul></details>;
}
