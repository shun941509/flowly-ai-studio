"use client";
/**
 * 하위 워크플로를 독립된 편집 복사본으로 여는 시각 편집기.
 * 사용자·문서·중첩 경로별 초안과 실행 취소를 유지하며 상위 적용 전까지 원본 연결을 바꾸지 않는다.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Workbench } from "./workbench";
import { FlowCanvas, NodeInspector, NodePalette } from './canvas';
import { Icon, IconButton } from './common';
import { advancedDefaults } from './advanced-nodes';
import { extendedDefaults } from './extended-nodes';
import { statefulDefaults } from './stateful-nodes';
import { programDefaults } from './program-nodes';
import { childPath, pathKey, nestedDraftKey, encodeNestedDraft, decodeNestedDraft, type NestedDraft, type NestedStep } from '../../domain/nested-editing';
import { EditorCompositionContext, useEditorComposition, currentNestedInspection, clearNestedInspection } from './editor-composition-context';
import { EditorDiagnostics } from './editor-diagnostics';
import { type Definition, type FlowNode, type NodeType, type Workflow, nodeNames, parseDefinition, uid } from '../lib/model';
import { compileDefinition } from '../../domain/workflow';
import { isStartNode } from '../../domain/advanced-config';
import { replaceEmbeddedDefinition } from '../../domain/editor-composition';
import { appendFragment, EditorHistory, removeSelection, selectionFragment } from '../../domain/editor-operations';
import { placeNewNode } from '../../domain/workflow-layout';

/** 하위 설계 진입 버튼과 오류 경로에 따른 자동 열기를 제공한다. 재귀 문맥으로 현재 하위 설계의 위치를 찾는다. */
export function DefinitionEditor({value,onChange,workflows,workflowId,label}:{value:Definition;onChange:(definition:Definition)=>void;workflows:Workflow[];workflowId:string;label:string}){
 const [open,setOpen]=useState(false);const parent=useEditorComposition();
 const locationPath=[...(parent?.locationPath??[]),...(parent?childPath(parent.definition,value)??[]:[])],location=pathKey(locationPath);
 useEffect(()=>{const inspect=()=>{const request=currentNestedInspection();if(request?.workflowId===workflowId&&request.path.length>=locationPath.length&&locationPath.length>0&&pathKey(request.path.slice(0,locationPath.length))===location)setOpen(true);};const timer=setTimeout(inspect,0);window.addEventListener('flowly-nested-inspection',inspect);return()=>{clearTimeout(timer);window.removeEventListener('flowly-nested-inspection',inspect);};},[workflowId,location,locationPath.length]);
 return <><button type="button" className="embedded-flow-button" onClick={()=>setOpen(true)}><Icon name="workflow" size={17}/><span><strong>{label}</strong><small>{value.nodes.length}개 블록 · {value.edges.length}개 연결 · 화면에서 편집</small></span><Icon name="chevronRight" size={15}/></button>{open&&<NestedEditor value={value} onChange={onChange} workflows={workflows} workflowId={workflowId} label={label} locationPath={locationPath} onClose={()=>{clearNestedInspection();setOpen(false);}}/>}</>;
}
/** 시각 설계 변경과 아직 반영하지 않은 JSON 텍스트 변경을 함께 판정한다. JSON 초안을 닫으며 잃지 않도록 구분한다. */
export function nestedEditorChanges(value:Definition,definition:Definition,jsonOpen:boolean,json:string){
 const jsonChanged=jsonOpen&&json!==JSON.stringify(definition,null,2);
 return {jsonChanged,changed:jsonChanged||JSON.stringify(definition)!==JSON.stringify(value)};
}
/** 로컬 정의·선택·초안·JSON 편집 상태를 소유한다. buildRoot로 현재 수정을 전체 설계에 임시 반영하여 중첩 제한을 확인한다. */
function NestedEditor({value,onChange,workflows,workflowId,label,onClose,locationPath}:{value:Definition;onChange:(definition:Definition)=>void;workflows:Workflow[];workflowId:string;label:string;onClose:()=>void;locationPath:NestedStep[]}){
 const parent=useEditorComposition();
 const request=currentNestedInspection(),target=request?.workflowId===workflowId&&pathKey(request.path.slice(0,locationPath.length))===pathKey(locationPath)?request:null;
 const [pendingDraft,setPendingDraft]=useState<NestedDraft|null>(null),[draftReady,setDraftReady]=useState(false);
 const draftStorageKey=parent?.userId?nestedDraftKey(parent.userId,workflowId,locationPath):null,base=JSON.stringify(value);
 const [definition,setDefinition]=useState(()=>structuredClone(value)),[selection,setSelection]=useState<string[]>(target?[target.path[locationPath.length]?.nodeId??target.nodeId]:[]),[inspector,setInspector]=useState(true),[message,setMessage]=useState(''),[jsonOpen,setJsonOpen]=useState(false),[json,setJson]=useState(''),[discard,setDiscard]=useState<'close'|'json'|null>(null),[historyVersion,setHistoryVersion]=useState({past:0,future:0}),[focusRequest,setFocusRequest]=useState<{id:string;version:number}|undefined>();
 const live=useRef(definition),history=useRef(new EditorHistory()),clipboard=useRef<ReturnType<typeof selectionFragment>|null>(null),dialog=useRef<HTMLDivElement>(null),gesture=useRef(false),mounted=useRef(true),id=useId();
 useLayoutEffect(()=>{live.current=definition;},[definition]);
 const {changed,jsonChanged}=nestedEditorChanges(value,definition,jsonOpen,json),selected=selection.at(-1)??null;
 const resources=parent?.resources??[],capabilities=parent?.capabilities;
 const buildRoot=(next:Definition)=>parent?parent.buildRoot(replaceEmbeddedDefinition(parent.definition,value,next)):next;
 const breadcrumbs=[...(parent?.breadcrumbs??['워크플로']),label.replace(/ 편집$/,'')];
 const workflow=useMemo<Workflow>(()=>({id:`${workflowId}:nested:${id}`,name:label,description:'하위 흐름의 편집 복사본',updatedAt:'',definition}),[definition,id,label,workflowId]);
 useEffect(()=>{mounted.current=true;const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return()=>{mounted.current=false;previous?.focus();};},[]);
 useEffect(()=>{const leave=(event:BeforeUnloadEvent)=>{if(changed){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[changed]);
 useEffect(()=>{const timer=setTimeout(()=>{if(draftStorageKey&&parent?.userId){try{const text=sessionStorage.getItem(draftStorageKey);if(text)setPendingDraft(decodeNestedDraft(text,parent.userId,workflowId,locationPath));}catch{setMessage('보관된 하위 초안을 읽을 수 없어요. 기존 설계는 유지됩니다.');}}setDraftReady(true);},0);return()=>clearTimeout(timer);},[draftStorageKey,parent?.userId,workflowId,locationPath]);
 useEffect(()=>{if(!draftReady||pendingDraft||!draftStorageKey||!parent?.userId||!changed)return;const save=()=>{try{sessionStorage.setItem(draftStorageKey,encodeNestedDraft({userId:parent.userId!,workflowId,path:locationPath,base,definition,jsonOpen,json}));}catch{setMessage('하위 초안을 보관하지 못했어요. 상위에 적용하거나 JSON으로 보관하세요.');}};const timer=setTimeout(save,300);window.addEventListener('pagehide',save);window.addEventListener('beforeunload',save);return()=>{clearTimeout(timer);window.removeEventListener('pagehide',save);window.removeEventListener('beforeunload',save);};},[draftReady,pendingDraft,draftStorageKey,changed,definition,jsonOpen,json,base,parent?.userId,workflowId,locationPath]);
 function clearDraft(){if(draftStorageKey)try{sessionStorage.removeItem(draftStorageKey);}catch{/* Storage is optional. */}}
 function keepDraft(){if(!draftStorageKey||!parent?.userId)return;try{sessionStorage.setItem(draftStorageKey,encodeNestedDraft({userId:parent.userId,workflowId,path:locationPath,base,definition,jsonOpen,json}));onClose();}catch(error){setMessage((error as Error).message);}}
 function close(){if(gesture.current)return;if(changed)setDiscard('close');else onClose();}
 function toggleJson(){if(jsonOpen){if(jsonChanged)setDiscard('json');else setJsonOpen(false);}else{setJson(JSON.stringify(live.current,null,2));setJsonOpen(true);}}
 function discardChanges(){if(discard==='json'){setJsonOpen(false);setDiscard(null);setMessage('JSON 변경을 버렸어요. 기존 화면 편집 구성은 유지돼요.');}else{clearDraft();onClose();}}
 /** 가장 안쪽 대화상자에서만 단축키를 처리한다. 상위 편집기에 같은 저장·닫기 키가 전달되지 않도록 전파를 멈춘다. */
 function key(event:KeyboardEvent<HTMLDivElement>){
  if((event.target as HTMLElement).closest('[role="dialog"]')!==dialog.current)return;
  event.stopPropagation();
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!event.nativeEvent.isComposing){event.preventDefault();if(gesture.current)return;if(jsonOpen)setMessage('JSON 내용을 먼저 편집 복사본에 반영한 뒤 상위 흐름에 적용해 주세요.');else apply();return;}
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(discard)setDiscard(null);else close();}
  if(event.key==='Tab'){
   const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,select,[tabindex="0"]')??[]).filter(e=>e.offsetParent!==null);
   const first=items[0],last=items.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
 }
 function change(next:Definition,record=true){if(record){history.current.record(live.current,next);setHistoryVersion({past:history.current.past.length,future:history.current.future.length});}live.current=next;setDefinition(next);setMessage('');}
 /** 하위 설계를 컴파일하고 루트 수준 파싱까지 통과한 후 부모 콜백에 반영한다. 적용 성공 후에만 복구 초안을 지우고 닫는다. */
 function apply(){try{const compiled=compileDefinition(definition);if(compiled.nodes.some(n=>n.type==='trigger'))throw new Error('하위 흐름의 시작은 사용자 입력 또는 입력 양식으로 설정해 주세요.');parseDefinition(buildRoot(compiled));onChange(compiled);clearDraft();onClose();}catch(error){setMessage((error as Error).message);}}
 function add(type:NodeType,x?:number,y?:number,request=false){
  if(gesture.current)return;
  if(type==='trigger'){setMessage('자동 시작은 최상위 흐름에만 사용할 수 있어요. 하위 흐름에는 입력 또는 입력 양식을 사용하세요.');return;}
  if(live.current.nodes.length>=40){setMessage('한 흐름에 블록은 40개까지 추가할 수 있어요.');return;}
  if((type==='input'||type==='form'&&!request)&&live.current.nodes.some(isStartNode)){setMessage('하위 흐름의 시작 블록은 하나예요. 기존 시작을 지우거나 보완 입력을 추가하세요.');return;}
  const node:FlowNode={id:uid('node'),type,title:request?'보완 입력':nodeNames[type],...placeNewNode(live.current,x!==undefined&&y!==undefined?{x,y}:undefined),
   ...(['ai','agent'].includes(type)?{prompt:'전달받은 요청을 수행하고 결과를 작성하세요.',format:'Markdown'}:{}),
   ...(type==='tool'?{allowedTools:[],tool:{arguments:{},bindings:{}}}:{}),...(type==='program'?programDefaults():{}),...statefulDefaults(type),
   ...(type==='transform'?{transform:{mode:'pick' as const,fields:{text:'text'}}}:{}),...(type==='merge'?{merge:{mode:'object' as const}}:{}),
   ...(type==='retrieval'?{retrieval:{resourceIds:[],topK:3,chunkSize:700}}:{}),...advancedDefaults(type),...extendedDefaults(type),
   ...(request?{form:{...advancedDefaults('form').form!,mode:'request' as const,instructions:'필요한 정보를 입력해 주세요.',timeoutMinutes:1440}}:{}),
  };
  change({...live.current,schemaVersion:5,nodes:[...live.current.nodes,node]});setSelection([node.id]);setInspector(true);
 }
 function remove(edgeId?:string){if(gesture.current)return;change(removeSelection(live.current,edgeId?[]:selection,edgeId?[edgeId]:[]));if(!edgeId)setSelection([]);}
 function duplicate(){if(gesture.current)return;try{const result=appendFragment(live.current,selectionFragment(live.current,selection),uid);change(result.definition);setSelection(result.ids);}catch(error){setMessage((error as Error).message);}}
 async function copy(){try{clipboard.current=selectionFragment(live.current,selection);try{await navigator.clipboard.writeText(JSON.stringify(clipboard.current));}catch{/* Local copy is sufficient inside this staged editor. */}if(mounted.current)setMessage('선택한 블록을 복사했어요. 이 하위 편집기에서 붙여넣을 수 있어요.');}catch(error){setMessage((error as Error).message);}}
 function paste(position?:{x:number;y:number}){if(gesture.current)return;try{if(!clipboard.current)throw new Error('이 하위 편집기에서 블록을 먼저 복사해 주세요.');const result=appendFragment(live.current,clipboard.current,uid,position);change(result.definition);setSelection(result.ids);}catch(error){setMessage((error as Error).message);}}
 function moveHistory(direction:'undo'|'redo'){if(gesture.current)return;const next=history.current[direction](live.current);if(next){change(next,false);setSelection(ids=>ids.filter(id=>next.nodes.some(n=>n.id===id)));setHistoryVersion({past:history.current.past.length,future:history.current.future.length});}}
 function inspect(nodeId:string){setSelection([nodeId]);setInspector(true);setFocusRequest(previous=>({id:nodeId,version:(previous?.version??0)+1}));}
 return createPortal(<div className="nested-editor-backdrop" style={{zIndex:200+breadcrumbs.length}}><div ref={dialog} className="nested-editor-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDown={key}>
  <header className="nested-editor-header"><div><nav aria-label="하위 흐름 경로">{breadcrumbs.map((name,index)=><span key={index}>{index>0&&<b> / </b>}{name}</span>)}</nav><h2 id={`${id}-title`}>{label}</h2><p>입력·출력 연결을 화면에서 편집하세요. Ctrl/Cmd+S는 상위 흐름에 적용하며, 서버 저장은 상위 화면에서 따로 해요.</p></div><IconButton icon="x" label="하위 편집 닫기" onClick={close}/></header>
  {pendingDraft&&<div className="editor-draft-banner" role="status"><span>적용 전 하위 초안을 찾았어요. {pendingDraft.base!==base?"상위 원본이 바뀌었습니다. 복구 후 차이를 확인하고 적용하세요.":"JSON 입력 중인 내용도 함께 복구합니다."}</span><button className="btn secondary" onClick={()=>{change(pendingDraft.definition);setJsonOpen(pendingDraft.jsonOpen);setJson(pendingDraft.json);setPendingDraft(null);}}>하위 초안 복구</button><button className="text-btn" onClick={()=>{clearDraft();setPendingDraft(null);}}>보관 초안 삭제</button></div>}
  <div className="nested-editor-actions"><label>저장한 흐름 복사<select aria-label="하위 편집에 저장 흐름 복사" disabled={jsonOpen} title={jsonOpen?'JSON 편집을 마친 뒤 다른 흐름을 복사하세요.':undefined} value="" onChange={e=>{const saved=workflows.find(w=>w.id===e.target.value);if(saved){change(structuredClone(saved.definition));setSelection([]);}}}><option value="">워크플로 선택</option>{workflows.filter(w=>w.id!==workflowId).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><button className="text-btn" onClick={toggleJson}>{jsonOpen?'화면 편집으로':'고급: JSON 편집'}</button><span>개별 40개 · 전체 120개 · 중첩 3단계</span></div>
  <EditorCompositionContext.Provider value={{definition,buildRoot,breadcrumbs,resources,capabilities,workflows,workflowId,userId:parent?.userId,locationPath}}>
  {jsonOpen?<div className="nested-json"><label className="field-label">하위 흐름 JSON<textarea value={json} rows={18} maxLength={500000} onChange={e=>setJson(e.target.value)} spellCheck={false}/></label><button className="btn secondary" onClick={()=>{try{change(parseDefinition(JSON.parse(json)));setJsonOpen(false);setDiscard(null);}catch(error){setMessage((error as Error).message);}}}>JSON을 편집 복사본에 반영</button><p>JSON은 고급 입력 방식이에요. 상위 흐름 적용은 아래 적용 버튼에서 별도로 검사해요.</p></div>:<Workbench className="nested-workbench" storageKey={`${parent?.userId??"local"}:nested`} palette={<NodePalette onAdd={add} onAddInputRequest={()=>add('form',undefined,undefined,true)} onManage={()=>setMessage('등록된 도구 및 자료를 오른쪽 블록 설정에서 선택하세요. 새 등록은 상위 편집을 닫고 도구 및 자료에서 진행하세요.')}/>} inspector={inspector&&<NodeInspector node={definition.nodes.find(n=>n.id===selected)??null} resources={resources} definition={definition} capabilities={capabilities} workflows={workflows} workflowId={workflowId} onChange={node=>change({...live.current,nodes:live.current.nodes.map(n=>n.id===node.id?node:n)})} onDelete={()=>remove()} onDuplicate={duplicate} onClose={()=>setInspector(false)} onSettings={()=>setMessage('사내 MCP 연결 정의는 상위 화면의 도구 및 자료에서 등록하세요. 현재 등록된 연결은 이 설정에서도 선택할 수 있어요.')}/>}><FlowCanvas viewKey={`flowly:viewport:${parent?.userId??"local"}:${workflowId}:${pathKey(locationPath)}`} workflow={workflow} resources={resources} selected={selected} selectedIds={selection} onSelect={id=>{setSelection(id?[id]:[]);if(id)setInspector(true);}} onSelection={(ids,primary)=>setSelection(primary&&ids.includes(primary)?[...ids.filter(i=>i!==primary),primary]:ids)} onGestureChange={active=>{gesture.current=active;}} onChange={change} onAdd={add} onNotify={setMessage} onCopy={()=>void copy()} onPaste={paste} onDuplicate={duplicate} onDelete={remove} onRename={()=>{setInspector(true);requestAnimationFrame(()=>dialog.current?.querySelector<HTMLInputElement>('[data-node-name]')?.focus());}} undo={()=>moveHistory('undo')} redo={()=>moveHistory('redo')} canUndo={historyVersion.past>0} canRedo={historyVersion.future>0} inspector={inspector} toggleInspector={()=>setInspector(v=>!v)} focusRequest={focusRequest}/></Workbench>}
  <EditorDiagnostics workflow={workflow} resources={resources} capabilities={capabilities} onInspect={inspect}/>
  </EditorCompositionContext.Provider>
  {!!message&&<p className="nested-editor-message multiline" role="status">{message}</p>}
  {discard&&<div className="nested-discard" role="alert"><span>{discard==='json'?'반영하지 않은 JSON 변경을 버리고 화면 편집으로 돌아갈까요?':'적용하지 않은 하위 편집 내용을 버리고 상위로 돌아갈까요?'}</span><button className="btn secondary" onClick={()=>setDiscard(null)}>계속 편집</button><button className="btn secondary" disabled={!draftStorageKey} onClick={keepDraft}>초안 보관하고 닫기</button><button className="btn danger" onClick={discardChanges}>{discard==='json'?'JSON 변경 버리고 화면 편집':'변경 버리고 돌아가기'}</button></div>}
  <footer className="nested-editor-footer"><span>{changed?'적용하지 않은 변경 사항':'원본과 같은 구성'} · {definition.nodes.length}개 블록 · {definition.edges.length}개 연결</span><button className="btn secondary" onClick={close}>상위로 돌아가기</button><button className="btn primary" disabled={jsonOpen} title="상위 흐름에 적용 (Ctrl/Cmd+S) · 서버 저장은 별도" onClick={apply}>검증하고 상위 흐름에 적용</button></footer>
 </div></div>,document.body);
}
