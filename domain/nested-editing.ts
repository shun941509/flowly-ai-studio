/**
 * 적용 전 하위 워크플로 편집 상태를 부모 노드/자식 인덱스 경로로 식별한다.
 * 초안은 사용자·워크플로·중첩 경로별로 분리되며 서버에 저장된 버전과 별개의 브라우저 복구 자료다.
 */
import { parseDefinition, type Definition } from '../app/lib/model';
import { childDefinitions } from './advanced-config';
export type NestedStep={nodeId:string;childIndex:number};
/**
 * 객체 참조가 같은 자식까지의 경로를 찾는다. 구조가 같은 형제 설계를 혼동하지 않는다.
 */
export function childPath(parent:Definition,target:Definition):NestedStep[]|null{
 for(const node of parent.nodes){const children=childDefinitions(node);for(const [childIndex,child] of children.entries()){if(child===target)return [{nodeId:node.id,childIndex}];const rest=childPath(child,target);if(rest)return [{nodeId:node.id,childIndex},...rest];}}
 return null;
}
export const pathKey=(path:NestedStep[])=>path.map(step=>`${encodeURIComponent(step.nodeId)}:${step.childIndex}`).join('/');
export type NestedDraft={version:1;userId:string;workflowId:string;path:NestedStep[];base:string;definition:Definition;jsonOpen:boolean;json:string;savedAt:string};
export const nestedDraftKey=(userId:string,workflowId:string,path:NestedStep[])=>`flowly-nested-v1:${encodeURIComponent(userId)}:${encodeURIComponent(workflowId)}:${pathKey(path)}`;
/**
 * 검증한 하위 설계와 아직 적용하지 않은 JSON 편집 상태를 함께 보관한다.
 */
export function encodeNestedDraft(value:Omit<NestedDraft,'version'|'savedAt'>):string{const text=JSON.stringify({...value,definition:parseDefinition(value.definition),version:1,savedAt:new Date().toISOString()});if(text.length>2_000_000)throw new Error('하위 초안이 너무 커요. JSON으로 따로 보관하세요.');return text;}
/**
 * 다른 사용자·워크플로·자식 경로의 초안을 잘못 복구하지 않도록 식별자를 재검사한다.
 */
export function decodeNestedDraft(text:string,userId:string,workflowId:string,path:NestedStep[]):NestedDraft{
 if(text.length>2_000_000)throw new Error('초안 크기를 확인하세요.');const value=JSON.parse(text) as NestedDraft;
 if(value?.version!==1||value.userId!==userId||value.workflowId!==workflowId||pathKey(value.path??[])!==pathKey(path)||typeof value.base!=='string'||typeof value.json!=='string'||typeof value.jsonOpen!=='boolean'||!Number.isFinite(Date.parse(value.savedAt)))throw new Error('현재 사용자와 하위 흐름의 초안이 아니에요.');
 return {...value,definition:parseDefinition(value.definition)};
}
