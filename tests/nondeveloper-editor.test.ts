import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {nodeNames,type Definition,type Workflow} from '../app/lib/model';
import {guideTerms,guideMarkdown,explainWorkflow} from '../domain/workflow-guide';
import {childPath,decodeNestedDraft,encodeNestedDraft,nestedDraftKey} from '../domain/nested-editing';
import {diagnosticLocations} from '../app/ui/editor-diagnostics';
import {replaceExampleNode} from '../app/ui/example-customizer';
import {InputMappings} from '../app/ui/input-mappings';
import {FlowCanvas,NodeInspector} from '../app/ui/canvas';
import {mappingIssues} from '../domain/data-contract';
const base=():Definition=>({schemaVersion:5,nodes:[{id:'in',type:'input',title:'입력',x:0,y:0},{id:'work',type:'agent',title:'분석',x:0,y:180,prompt:'근거를 확인하세요.'},{id:'out',type:'output',title:'결과',x:0,y:360}],edges:[{id:'a',source:'in',target:'work'},{id:'b',source:'work',target:'out'}]});
const workflow=(definition=base()):Workflow=>({id:'flow',name:'검사',description:'',definition,updatedAt:''});
test('guide covers all existing node terms and six explanations; shared markdown has same terms',()=>{
 assert.equal(new Set(guideTerms.map(item=>item.id)).size,guideTerms.length);
 for(const type of Object.keys(nodeNames))assert.ok(guideTerms.some(item=>item.id===type),type);
 for(const item of guideTerms)for(const field of ['meaning','when','where','example','difference','support'] as const)assert.ok(item[field].trim().length>0,`${item.id}:${field}`);
 const text=guideMarkdown();for(const item of guideTerms)assert.ok(text.includes(item.meaning));assert.match(text,/Agent 블록 없이/);assert.match(text,/웹.*OpenAI|웹.*모델 호출/);
});
test('graph prose uses dependencies and actual branches, mappings and failures rather than visual order',()=>{
 const graph=base();graph.nodes[1]={...graph.nodes[1],type:'condition',predicate:{path:'text',operator:'eq',value:'yes'}};graph.nodes.push({id:'no',type:'output',title:'보류',x:-999,y:-999});graph.edges[1].branch='yes';graph.edges.push({id:'no-edge',source:'work',target:'no',branch:'no'});graph.nodes.reverse();
 const prose=explainWorkflow(graph).join('\n');assert.ok(prose.indexOf('입력: 흐름 시작')<prose.indexOf('분석:'));assert.match(prose,/예: 결과/);assert.match(prose,/아니요: 보류/);assert.match(prose,/입력의 text → 분석의 text/);assert.match(prose,/오류는 실행을 중단/);
});
test('unapplied nested drafts preserve unfinished JSON and isolate user/workflow/sibling paths',()=>{
 const path=[{nodeId:'group',childIndex:1}],draft={userId:'alice',workflowId:'flow',path,base:JSON.stringify(base()),definition:base(),jsonOpen:true,json:'{ unfinished'};
 const encoded=encodeNestedDraft(draft),decoded=decodeNestedDraft(encoded,'alice','flow',path);assert.equal(decoded.json,draft.json);assert.equal(decoded.jsonOpen,true);assert.deepEqual(decoded.definition.nodes.map(n=>n.id),['in','work','out']);
 assert.throws(()=>decodeNestedDraft(encoded,'bob','flow',path));assert.throws(()=>decodeNestedDraft(encoded,'alice','another',path));assert.throws(()=>decodeNestedDraft(encoded,'alice','flow',[{nodeId:'group',childIndex:0}]));assert.notEqual(nestedDraftKey('alice','flow',path),nestedDraftKey('alice','flow',[{nodeId:'group',childIndex:0}]));
});
test('nested diagnostics locate the actual child even when sibling node IDs are identical',()=>{
 const left=base(),right=base();right.nodes[1].inputBindings={text:{nodeId:'missing',path:'text'}};
 const graph=base();graph.nodes[1]={id:'work',type:'parallel',title:'분석 묶음',x:0,y:180,parallel:{concurrency:2,tasks:[{id:'left',name:'왼쪽',definition:left},{id:'right',name:'오른쪽',definition:right}]}};
 assert.deepEqual(childPath(graph,right),[{nodeId:'work',childIndex:1}]);assert.equal(childPath(graph,structuredClone(right)),null);
 const locations=diagnosticLocations(workflow(graph),[]);assert.ok(locations.some(issue=>issue.nodeId==='work'&&issue.path[0]?.childIndex===1&&issue.message.includes('직접 연결')));
});
test('customizing an example modifies a selected nested role only and preserves original plus edges',()=>{
 const left=base(),right=base(),graph=base();graph.nodes[1]={id:'work',type:'parallel',title:'분석 묶음',x:0,y:180,parallel:{concurrency:2,tasks:[{id:'left',name:'왼쪽',definition:left},{id:'right',name:'오른쪽',definition:right}]}};
 const before=structuredClone(graph),next=replaceExampleNode(graph,right.nodes[1],{prompt:'새 검토 지침'});assert.deepEqual(graph,before);assert.equal(next.nodes[1].parallel!.tasks[0].definition.nodes[1].prompt,'근거를 확인하세요.');assert.equal(next.nodes[1].parallel!.tasks[1].definition.nodes[1].prompt,'새 검토 지침');assert.deepEqual(next.edges,graph.edges);
});
test('mapping UI explains illustrative values, required fields and skipped branch joins',()=>{
 const graph=base();graph.nodes[0]={...graph.nodes[0],type:'condition',condition:'yes'};graph.edges[0].branch='yes';graph.nodes[2].inputSchema={type:'object',required:['text'],properties:{text:{type:'string'}}};
 assert.ok(mappingIssues(graph,graph.nodes[2]).some(issue=>issue.message.includes('건너뛸')));
 const html=renderToStaticMarkup(createElement(InputMappings,{node:graph.nodes[2],definition:graph,onChange:()=>{}}));assert.match(html,/실제 응답이 아닙니다/);assert.match(html,/text 필수 입력/);assert.match(html,/빈 문장·빈 목록/);
});
test('read-only canvas disables mutation affordances while keeping zoom and select',()=>{
 const noop=()=>{};const html=renderToStaticMarkup(createElement(FlowCanvas,{workflow:workflow(),resources:[],selected:'work',selectedIds:['in','work'],onSelect:noop,onGestureChange:noop,onSelection:noop,onChange:noop,onAdd:noop,onNotify:noop,onCopy:noop,onPaste:noop,onDuplicate:noop,onDelete:noop,onRename:noop,undo:noop,redo:noop,canUndo:true,canRedo:true,inspector:false,toggleInspector:noop,readOnly:true}));
 assert.match(html,/disabled=""[^>]*>복제/);assert.match(html,/disabled=""[^>]*>삭제/);assert.match(html,/자동 정렬/);assert.match(html,/캔버스 이동/);assert.match(html,/전체 흐름에 맞추기/);
});
test('tool help follows actual text/data response and links to guide without navigation',()=>{
 const graph=base();graph.nodes[1]={...graph.nodes[1],type:'tool',allowedTools:[],tool:{arguments:{},bindings:{}}};
 const html=renderToStaticMarkup(createElement(NodeInspector,{node:graph.nodes[1],definition:graph,resources:[],onChange:()=>{},onDelete:()=>{},onDuplicate:()=>{},onClose:()=>{},onSettings:()=>{},workflows:[],workflowId:'flow'}));assert.match(html,/data\(도구의 구조화된 응답\)/);assert.doesNotMatch(html,/text와 result/);assert.match(html,/가이드에서 알아보기/);
});
