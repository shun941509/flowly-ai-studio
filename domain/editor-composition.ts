/**
 * 미완성 그래프의 연결 검사, 중첩 설계 교체, 정렬, 사용자별 로컬 초안을 담당한다.
 * 좌표 변경과 실행 연결 변경을 구분하고 브라우저 초안을 서버 저장본처럼 취급하지 않는다.
 */
import { parseDefinition, type Definition, type FlowEdge, type Workflow } from '../app/lib/model';
import { isStartNode, nodeRoutes } from './advanced-config';
import { WORKFLOW_NODE_HEIGHT, WORKFLOW_NODE_WIDTH } from './workflow-layout';

/** Check one proposed edge without requiring an unfinished graph to compile. */
/**
 * 편집 중 추가할 연결 하나를 검사한다. 전체 흐름이 아직 미완성이라는 이유만으로 모든 연결을 막지 않는다.
 */
export function connectionError(definition: Definition, edge: Pick<FlowEdge, 'source' | 'target' | 'branch'>): string | null {
 const source=definition.nodes.find(n=>n.id===edge.source),target=definition.nodes.find(n=>n.id===edge.target);
 if(!source||!target)return '연결할 블록을 찾을 수 없어요.';
 if(source.id===target.id)return '같은 블록으로 연결할 수 없어요.';
 if(isStartNode(target))return '시작 블록으로는 연결할 수 없어요.';
 if(source.type==='output')return '출력 블록은 흐름의 마지막이에요.';
 if(definition.edges.some(e=>e.source===edge.source&&e.target===edge.target&&e.branch===edge.branch))return '이미 같은 연결이 있어요.';
 if(definition.edges.length>=80)return '개별 흐름의 연결은 80개까지 사용할 수 있어요.';
 const routes=nodeRoutes(source);
 if(routes.length?!routes.some(route=>route.id===edge.branch):!!edge.branch)return '이 블록에 등록된 분기 경로를 선택해 주세요.';
 const seen=new Set<string>(),pending=[target.id];
 while(pending.length){const id=pending.pop()!;if(id===source.id)return '이 연결은 순환을 만들어요. 반복은 항목별 반복 또는 작업 조정 블록 안에서 구성하세요.';if(seen.has(id))continue;seen.add(id);pending.push(...definition.edges.filter(e=>e.source===id).map(e=>e.target));}
 return null;
}

/** Immutable identity-based replacement prevents identical sibling copies being edited together. */
/**
 * 내용이 같은 다른 자식까지 바꾸지 않도록 객체 참조가 일치하는 대상 하나만 교체한다.
 */
export function replaceEmbeddedDefinition(root:Definition,target:Definition,replacement:Definition):Definition {
 let matches=0;
 const visit=(definition:Definition):Definition=>{
  if(definition===target){matches++;return replacement;}
  return {...definition,nodes:definition.nodes.map(node=>({...node,
   ...(node.parallel?{parallel:{...node.parallel,tasks:node.parallel.tasks.map(t=>({...t,definition:visit(t.definition)}))}}:{}),
   ...(node.team?{team:{...node.team,tasks:node.team.tasks.map(t=>({...t,definition:visit(t.definition)}))}}:{}),
   ...(node.orchestration?{orchestration:{...node.orchestration,tasks:node.orchestration.tasks.map(t=>({...t,definition:visit(t.definition)}))}}:{}),
   ...(node.subworkflow?{subworkflow:{...node.subworkflow,definition:visit(node.subworkflow.definition)}}:{}),
   ...(node.loop?{loop:{...node.loop,definition:visit(node.loop.definition)}}:{}),
  }))};
 };
 const next=visit(root);
 if(matches!==1)throw new Error('상위 흐름이 바뀌었어요. 편집을 닫고 하위 흐름을 다시 열어 주세요.');
 return next;
}
/**
 * 하위 편집 결과를 부모에 반영한 전체 그래프로 검사해 깊이·노드 예산 초과를 잡는다.
 */
export function validateEmbeddedChange(root:Definition,target:Definition,replacement:Definition):Definition {
 const next=replaceEmbeddedDefinition(root,target,replacement);
 parseDefinition(next); // Recursive schema, depth 3, total 120 and per-graph budgets.
 return next;
}

export type Alignment='left'|'center'|'top'|'middle'|'horizontal'|'vertical';
/**
 * 선택 노드의 위치만 정렬한다. 연결선의 실행 순서와 입출력 매핑은 수정하지 않는다.
 */
export function alignSelection(definition:Definition,ids:readonly string[],mode:Alignment):Definition {
 const selected=new Set(ids),nodes=definition.nodes.filter(n=>selected.has(n.id));
 if(nodes.length<2)return definition;
 const minX=Math.min(...nodes.map(n=>n.x)),maxX=Math.max(...nodes.map(n=>n.x)),minY=Math.min(...nodes.map(n=>n.y)),maxY=Math.max(...nodes.map(n=>n.y));
 const points=new Map(nodes.map(n=>[n.id,{x:n.x,y:n.y}]));
 if(mode==='horizontal'||mode==='vertical'){
  if(nodes.length<3)return definition;
  const horizontal=mode==='horizontal',sorted=[...nodes].sort((a,b)=>(horizontal?a.x-b.x:a.y-b.y)||a.id.localeCompare(b.id));
  // Preserve endpoints and require enough room for the actual node dimensions.
  const span=horizontal?maxX-minX:maxY-minY,size=horizontal?WORKFLOW_NODE_WIDTH:WORKFLOW_NODE_HEIGHT;
  if(span<(nodes.length-1)*size)throw new Error('같은 간격을 만들 공간이 부족해요. 양끝 블록을 더 벌린 뒤 다시 선택하세요.');
  sorted.forEach((n,i)=>{const p=points.get(n.id)!;if(horizontal)p.x=minX+span*i/(nodes.length-1);else p.y=minY+span*i/(nodes.length-1);});
 }else for(const point of points.values()){if(mode==='left')point.x=minX;if(mode==='center')point.x=(minX+maxX)/2;if(mode==='top')point.y=minY;if(mode==='middle')point.y=(minY+maxY)/2;}
 return {...definition,nodes:definition.nodes.map(n=>points.has(n.id)?{...n,...points.get(n.id)!}:n)};
}

export type EditorDraft={version:1;userId:string;workflow:Workflow;savedAt:string};
export const draftPrefix=(userId:string)=>`flowly-draft-v1:${encodeURIComponent(userId)}:`;
export const draftKey=(userId:string,workflowId:string)=>draftPrefix(userId)+encodeURIComponent(workflowId);
/**
 * 편집 중인 설계와 식별 정보를 크기 제한이 있는 초안으로 직렬화한다.
 */
export function encodeEditorDraft(userId:string,workflow:Workflow,now=new Date().toISOString()):string {
 // Only the editable document: never the resource catalogue, runtime connections or secrets.
 const value:EditorDraft={version:1,userId,savedAt:now,workflow:{id:workflow.id,name:workflow.name,description:workflow.description,updatedAt:workflow.updatedAt,definition:parseDefinition(workflow.definition)}};
 const text=JSON.stringify(value);if(text.length>2_000_000)throw new Error('초안이 너무 커서 이 탭에 보관할 수 없어요. JSON으로 내보내 주세요.');return text;
}
/**
 * 초안의 사용자·형식·저장 시각과 설계를 확인한 뒤 복구한다.
 */
export function decodeEditorDraft(text:string,userId:string):EditorDraft {
 if(text.length>2_000_000)throw new Error('초안 크기를 확인해 주세요.');
 const value=JSON.parse(text) as EditorDraft;
 if(value?.version!==1||value.userId!==userId||!value.workflow||typeof value.savedAt!=='string'||!Number.isFinite(Date.parse(value.savedAt)))throw new Error('현재 사용자에게 속한 초안이 아니에요.');
 const w=value.workflow;
 if(typeof w.id!=='string'||!w.id||typeof w.name!=='string'||w.name.length>80||typeof w.description!=='string'||typeof w.updatedAt!=='string')throw new Error('초안 문서 형식을 확인해 주세요.');
 return {version:1,userId,savedAt:value.savedAt,workflow:{id:w.id,name:w.name,description:w.description,updatedAt:w.updatedAt,definition:parseDefinition(w.definition)}};
}
