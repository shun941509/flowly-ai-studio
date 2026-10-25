import { parseDefinition, type Definition, type FlowNode } from '../app/lib/model';
import { isStartNode } from './advanced-config';
import { WORKFLOW_NODE_HEIGHT, WORKFLOW_NODE_WIDTH } from './workflow-layout';

export type EditorPoint = {x:number;y:number};
export type EditorView = EditorPoint & {zoom:number};
export type EditorRect = EditorPoint & {width:number;height:number};
export const screenToWorld = (point:EditorPoint,view:EditorView):EditorPoint => ({x:(point.x-view.x)/view.zoom,y:(point.y-view.y)/view.zoom});
export function zoomAt(view:EditorView,point:EditorPoint,zoom:number):EditorView {
 const next=Math.max(.03,Math.min(1.6,zoom)),world=screenToWorld(point,view);
 return {zoom:next,x:point.x-world.x*next,y:point.y-world.y*next};
}
export const selectionRect=(a:EditorPoint,b:EditorPoint):EditorRect=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
export function nodesInRect(nodes:FlowNode[],rect:EditorRect):string[] {
 return nodes.filter(n=>n.x<=rect.x+rect.width&&n.x+WORKFLOW_NODE_WIDTH>=rect.x&&n.y<=rect.y+rect.height&&n.y+WORKFLOW_NODE_HEIGHT>=rect.y).map(n=>n.id);
}
/** Clamp one shared delta so a group never changes its relative arrangement. */
export function moveSelection(definition:Definition,ids:readonly string[],delta:EditorPoint):Definition {
 const selected=new Set(ids),nodes=definition.nodes.filter(n=>selected.has(n.id));
 if(!nodes.length)return definition;
 const dx=Math.max(-10000-Math.min(...nodes.map(n=>n.x)),Math.min(10000-Math.max(...nodes.map(n=>n.x)),delta.x));
 const dy=Math.max(-10000-Math.min(...nodes.map(n=>n.y)),Math.min(10000-Math.max(...nodes.map(n=>n.y)),delta.y));
 if(!dx&&!dy)return definition;
 return {...definition,nodes:definition.nodes.map(n=>selected.has(n.id)?{...n,x:n.x+dx,y:n.y+dy}:n)};
}
export function disconnectedInputs(definition:Definition,node:FlowNode):string[] {
 const fields=Object.entries(node.inputBindings??{}).filter(([,binding])=>!definition.edges.some(e=>e.source===binding.nodeId&&e.target===node.id)).map(([field])=>field);
 if(node.compensation&&!definition.nodes.some(n=>n.id===node.compensation?.sourceNodeId))fields.push('보상 대상');
 return fields;
}
export function removeSelection(definition:Definition,ids:readonly string[],edgeIds:readonly string[]=[]):Definition {
 const nodes=new Set(ids),edges=new Set(edgeIds);
 // Preserve explicit missing bindings so the inspector requires reconnection rather than silently changing data flow.
 return {...definition,nodes:definition.nodes.filter(n=>!nodes.has(n.id)).map(n=>n.inputBindings===undefined&&definition.edges.some(e=>e.target===n.id&&(nodes.has(e.source)||edges.has(e.id)))?{...n,inputBindings:Object.fromEntries(definition.edges.filter(e=>e.target===n.id).map((e,i)=>[i===0?'text':`context_${i}`,{nodeId:e.source,path:'text'}]))}:n),edges:definition.edges.filter(e=>!nodes.has(e.source)&&!nodes.has(e.target)&&!edges.has(e.id))};
}
export type EditorFragment={kind:'flowly-selection';version:1;definition:Definition};
export function canApplyClipboard(snapshot:{workflowId:string;definition:Definition},current:{workflowId:string;definition:Definition},gestureActive:boolean):boolean {
 return !gestureActive&&snapshot.workflowId===current.workflowId&&snapshot.definition===current.definition;
}
export function selectionFragment(definition:Definition,ids:readonly string[]):EditorFragment {
 const selected=new Set(ids);
 const nodes=definition.nodes.filter(n=>selected.has(n.id)).map(n=>({...structuredClone(n),inputBindings:n.inputBindings??Object.fromEntries(definition.edges.filter(e=>e.target===n.id).map((e,i)=>[i===0?'text':`context_${i}`,{nodeId:e.source,path:'text'}]))}));
 if(!nodes.length)throw new Error('복사할 블록을 선택해 주세요.');
 return {kind:'flowly-selection',version:1,definition:{schemaVersion:definition.schemaVersion,nodes,edges:structuredClone(definition.edges.filter(e=>selected.has(e.source)&&selected.has(e.target)))}};
}
export function parseEditorFragment(text:string):EditorFragment {
 if(text.length>2_000_000)throw new Error('붙여넣을 블록 데이터가 너무 큽니다.');
 let raw:unknown;try{raw=JSON.parse(text);}catch{throw new Error('Flowly에서 복사한 블록을 붙여넣어 주세요.');}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('블록 복사 형식이 올바르지 않습니다.');
 const value=raw as Record<string,unknown>;
 if(value.kind!=='flowly-selection'||value.version!==1||Object.keys(value).some(k=>!['kind','version','definition'].includes(k)))throw new Error('지원하지 않는 블록 복사 형식입니다.');
 const definition=parseDefinition(value.definition);
 if(!definition.nodes.length)throw new Error('붙여넣을 블록이 없습니다.');
 return {kind:'flowly-selection',version:1,definition};
}
export function appendFragment(definition:Definition,fragment:EditorFragment,makeId:(prefix:string)=>string,position?:EditorPoint):{definition:Definition;ids:string[]} {
 const source=parseEditorFragment(JSON.stringify(fragment)).definition;
 if(definition.nodes.length+source.nodes.length>40)throw new Error('붙여넣은 뒤 블록이 40개를 넘습니다. 전체 작업을 취소했어요.');
 if(definition.nodes.filter(isStartNode).length+source.nodes.filter(isStartNode).length>1)throw new Error('시작 블록은 하나만 사용할 수 있어요. 시작 블록을 선택에서 제외해 주세요.');
 if(definition.edges.length+source.edges.length>80)throw new Error('연결은 80개까지 사용할 수 있어요.');
 const ids=new Map(source.nodes.map(n=>[n.id,makeId('node')]));
 let moved:Definition={...source,nodes:source.nodes.map(node=>({...node,id:ids.get(node.id)!,title:node.title.slice(0,80),inputBindings:Object.fromEntries(Object.entries(node.inputBindings??{}).map(([key,binding])=>[key,{...binding,nodeId:ids.get(binding.nodeId)??binding.nodeId}])),...(node.compensation?{compensation:{...node.compensation,sourceNodeId:ids.get(node.compensation.sourceNodeId)??node.compensation.sourceNodeId}}:{})})),edges:source.edges.map(e=>({...e,id:makeId('edge'),source:ids.get(e.source)!,target:ids.get(e.target)!}))};
 const left=Math.min(...source.nodes.map(n=>n.x)),top=Math.min(...source.nodes.map(n=>n.y));
 moved=moveSelection(moved,[...ids.values()],position?{x:position.x-left,y:position.y-top}:{x:40,y:40});
 const combined={...definition,schemaVersion:5 as const,nodes:[...definition.nodes,...moved.nodes],edges:[...definition.edges,...moved.edges]};
 parseDefinition(combined); // Validate nested configurations and the whole-document budget before any mutation.
 return {definition:combined,ids:[...ids.values()]};
}
export class EditorHistory {
 past:Definition[]=[];future:Definition[]=[];
 record(before:Definition,after:Definition){if(JSON.stringify(before)===JSON.stringify(after))return false;this.past=[...this.past,structuredClone(before)].slice(-50);this.future=[];return true;}
 undo(current:Definition){const previous=this.past.pop();if(!previous)return null;this.future.push(structuredClone(current));return previous;}
 redo(current:Definition){const next=this.future.pop();if(!next)return null;this.past.push(structuredClone(current));return next;}
 reset(){this.past=[];this.future=[];}
}
