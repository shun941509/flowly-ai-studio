"use client";
/**
 * 중첩 편집기가 현재 복사본을 루트 설계로 투영하는 문맥과 오류 위치 이동 신호를 공유한다. 신호는 일시적인 UI 상태로 저장 설계에 포함되지 않는다.
 */

import { createContext, useContext } from 'react';
import type { Definition, Resource, Workflow } from '../lib/model';
import type { RuntimeCapabilities } from '../../runtime/types';
import type { NestedStep } from '../../domain/nested-editing';

export type CompositionContext={
 definition:Definition;buildRoot:(next:Definition)=>Definition;breadcrumbs:string[];
 resources:Resource[];capabilities?:RuntimeCapabilities|null;workflows:Workflow[];workflowId:string;
 userId?:string;locationPath?:NestedStep[];
};
export const EditorCompositionContext=createContext<CompositionContext|null>(null);
export const useEditorComposition=()=>useContext(EditorCompositionContext);
export type NestedInspection={workflowId:string;path:NestedStep[];nodeId:string;message?:string;at:number};
let inspection:NestedInspection|null=null;
export function currentNestedInspection(){return inspection;}
export function clearNestedInspection(){inspection=null;}
/** 오류가 있는 하위 경로를 보관한 뒤 열린 편집기들에 알린다. 각 편집기는 자신의 경로와 일치하는 부분만 처리한다. */
export function requestNestedInspection(value:Omit<NestedInspection,'at'>){inspection={...value,at:Date.now()};window.dispatchEvent(new Event('flowly-nested-inspection'));}

/** 현재 검사 메시지의 설정 영역을 선택한다. 실제 하위 경로는 NestedInspection으로 별도 확인한다. */
export function inspectorTabForMessage(message:string){if(/한도|토큰|오류 경로/.test(message))return "advanced";if(/입력|매핑|출력 형식|자료형|스키마|경로/.test(message))return "io";if(/자료|도구|MCP|Skill|Prompt|검색/.test(message))return "materials";return "basic";}
