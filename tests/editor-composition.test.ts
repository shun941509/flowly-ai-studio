import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alignSelection,connectionError,decodeEditorDraft,draftKey,encodeEditorDraft,replaceEmbeddedDefinition,validateEmbeddedChange} from '../domain/editor-composition';
import {parseDefinition,type Definition,type FlowNode,type Workflow} from '../app/lib/model';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NodeInspector} from '../app/ui/canvas';
import {EditorDiagnostics} from '../app/ui/editor-diagnostics';
import {nestedEditorChanges} from '../app/ui/nested-editor';
const base=():Definition=>({schemaVersion:5,nodes:[{id:'in',type:'input',title:'입력',x:0,y:0},{id:'a',type:'agent',title:'분석',x:300,y:160,prompt:'분석해 주세요.'},{id:'b',type:'agent',title:'검증',x:600,y:200,prompt:'검증해 주세요.'},{id:'out',type:'output',title:'결과',x:900,y:500}],edges:[{id:'ia',source:'in',target:'a'},{id:'ab',source:'a',target:'b'},{id:'bo',source:'b',target:'out'}]});
const container=(child:Definition,id='nested'):FlowNode=>({id,type:'subworkflow',title:id,x:300,y:300,subworkflow:{definition:child}});
const wrap=(child:Definition):Definition=>({...base(),nodes:[base().nodes[0],container(child),base().nodes[3]],edges:[{id:'in-n',source:'in',target:'nested'},{id:'n-out',source:'nested',target:'out'}]});
test('connection guard rejects cycles before mutation while allowing valid unfinished graph edges',()=>{
 const d=base(),before=structuredClone(d);
 assert.match(connectionError(d,{source:'b',target:'a'})!,/순환/);
 assert.match(connectionError(d,{source:'a',target:'a'})!,/같은 블록/);
 assert.match(connectionError(d,{source:'a',target:'in'})!,/시작/);
 assert.match(connectionError(d,{source:'out',target:'b'})!,/마지막/);
 assert.match(connectionError(d,{source:'in',target:'a'})!,/이미/);
 assert.equal(connectionError(d,{source:'in',target:'b'}),null);assert.deepEqual(d,before);
 const full={...d,edges:Array.from({length:80},(_,i)=>({id:`e${i}`,source:'in',target:'a'}))};
 assert.match(connectionError(full,{source:'in',target:'b'})!,/80/);
});
test('connection guard validates actual branch labels rather than accepting an unlabeled condition',()=>{
 const d=base();d.nodes[1]={...d.nodes[1],type:'condition',predicate:{path:'text',operator:'eq',value:'yes'}};d.edges=[];
 assert.match(connectionError(d,{source:'a',target:'b'})!,/경로/);
 assert.equal(connectionError(d,{source:'a',target:'b',branch:'yes'}),null);
 assert.match(connectionError(d,{source:'in',target:'a',branch:'yes'})!,/경로/);
});
test('staged child replacement edits only one identical sibling and never mutates the parent',()=>{
 const left=base(),right=structuredClone(left),root:Definition={schemaVersion:5,nodes:[container(left,'left'),container(right,'right')],edges:[]};
 const before=structuredClone(root),replacement={...left,nodes:left.nodes.map(n=>n.id==='a'?{...n,title:'변경됨'}:n)};
 const result=validateEmbeddedChange(root,left,replacement);
 assert.equal(result.nodes[0].subworkflow!.definition.nodes[1].title,'변경됨');assert.equal(result.nodes[1].subworkflow!.definition.nodes[1].title,'분석');assert.deepEqual(root,before);
 assert.throws(()=>replaceEmbeddedDefinition(root,structuredClone(left),replacement),/다시 열어/);
});
test('root validation rejects depth and total budgets that are valid for an isolated child',()=>{
 const leaf=base(),root=wrap(wrap(wrap(leaf)));parseDefinition(root);
 assert.throws(()=>validateEmbeddedChange(root,leaf,wrap(base())),/3단계/);
 const many=(count:number):Definition=>({schemaVersion:5,nodes:Array.from({length:count},(_,i)=>({id:`n${i}`,type:'transform',title:`N${i}`,x:0,y:i,transform:{mode:'template',template:'x'}})),edges:[]});
 const a=many(38),b=many(38),c=many(38),large:Definition={schemaVersion:5,nodes:[container(a,'a'),container(b,'b'),container(c,'c'),...many(3).nodes],edges:[]};parseDefinition(large);
 assert.throws(()=>validateEmbeddedChange(large,a,many(39)),/전체 블록/);assert.equal(large.nodes[0].subworkflow!.definition.nodes.length,38);
});
test('nested automatic trigger and stale roots cannot bypass apply validation',()=>{
 const leaf=base(),root=wrap(leaf),replacement={...leaf,nodes:leaf.nodes.map(n=>n.id==='in'?{...n,type:'trigger' as const}:n)};
 assert.throws(()=>validateEmbeddedChange(root,leaf,replacement),/자동 시작/);
 assert.throws(()=>validateEmbeddedChange(root,base(),leaf),/다시 열어/);
});
test('alignment and equal spacing preserve execution graph and endpoint positions',()=>{
 const d=base(),aligned=alignSelection(d,['a','b'],'top');assert.equal(aligned.nodes[1].y,160);assert.equal(aligned.nodes[2].y,160);assert.deepEqual(aligned.edges,d.edges);assert.equal(d.nodes[2].y,200);
 const uneven={...d,nodes:d.nodes.map(n=>n.id==='a'?{...n,x:200}:n)};
 const spaced=alignSelection(uneven,['in','a','out'],'horizontal');assert.equal(spaced.nodes[0].x,0);assert.equal(spaced.nodes[1].x,450);assert.equal(spaced.nodes[3].x,900);assert.equal(spaced.nodes[2].x,600);
 assert.throws(()=>alignSelection({...d,nodes:d.nodes.map((n,i)=>({...n,x:i*10}))},['in','a','b'],'horizontal'),/공간/);
});
test('session drafts isolate users, accept incomplete DAG design and omit catalogue/runtime fields',()=>{
 const w:Workflow={id:'flow',name:'새 설계',description:'목표',updatedAt:'2026-10-25',definition:{...base(),edges:[]}};
 const unsafe={...w,resources:[{content:'must not persist'}],connections:[{token:'never'}]};
 const encoded=encodeEditorDraft('user:A',unsafe);assert.ok(!encoded.includes('must not persist'));assert.ok(!encoded.includes('never'));
 const decoded=decodeEditorDraft(encoded,'user:A');assert.equal(decoded.workflow.id,'flow');assert.equal(decoded.workflow.definition.edges.length,0);
 assert.throws(()=>decodeEditorDraft(encoded,'user:B'),/현재 사용자/);assert.notEqual(draftKey('a:b','c'),draftKey('a','b:c'));
 assert.throws(()=>decodeEditorDraft('{"version":9}','user:A'),/현재 사용자/);
});
test('nested inspector starts with visual edit and common data contract controls without a JSON editor',()=>{
 const definition=wrap(base()),node=definition.nodes[1];
 const html=renderToStaticMarkup(createElement(NodeInspector,{node,definition,resources:[],workflows:[],workflowId:'current',onChange:()=>{},onDelete:()=>{},onDuplicate:()=>{},onClose:()=>{},onSettings:()=>{}}));
 assert.match(html,/화면에서 편집/);assert.match(html,/입력 연결/);assert.match(html,/출력 형식 선언/);assert.doesNotMatch(html,/하위 워크플로 구성 JSON/);
});
test('diagnostics identify the owning block and provide a settings navigation action',()=>{
 const definition=base();definition.nodes[1].prompt='';
 const workflow:Workflow={id:'draft',name:'진단',description:'',updatedAt:'',definition};
 const html=renderToStaticMarkup(createElement(EditorDiagnostics,{workflow,resources:[],onInspect:()=>{}}));
 assert.match(html,/분석/);assert.match(html,/블록 설정 열기/);assert.match(html,/프롬프트/);
});
test('unapplied advanced JSON stays dirty even when visual definition is unchanged or JSON is invalid',()=>{
 const original=base(),staged=structuredClone(original),text=JSON.stringify(staged,null,2);
 assert.deepEqual(nestedEditorChanges(original,staged,true,text),{changed:false,jsonChanged:false});
 const edited=text.replace('분석','JSON에서 변경');
 assert.deepEqual(nestedEditorChanges(original,staged,true,edited),{changed:true,jsonChanged:true});
 assert.deepEqual(nestedEditorChanges(original,staged,true,'{unfinished:'),{changed:true,jsonChanged:true});
 assert.equal(nestedEditorChanges(original,staged,true,text).changed,false);
 const applied=JSON.parse(edited) as Definition;
 assert.deepEqual(nestedEditorChanges(original,applied,false,edited),{changed:true,jsonChanged:false});
 assert.deepEqual(nestedEditorChanges(original,staged,false,edited),{changed:false,jsonChanged:false});
 assert.equal(original.nodes[1].title,'분석');
});
