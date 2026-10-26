import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Definition,Resource} from '../app/lib/model';
import {serializeMcpRegistration} from '../domain/mcp-registration';
import {ExampleMaterials,exampleResourceReplacementIssue,mergeExampleResources,rebindExampleResource} from '../app/ui/example-customizer';

const resource=(id:string,type:Resource['type']='document',content='샘플 본문'):Resource=>({id,type,content,name:id,description:'검증용 자료',url:'',ownerId:'test:alice',visibility:'private',allowedEmails:[],createdAt:'',updatedAt:''});
const mcp=(id:string,toolName='lookup',effect:'read'|'write'='read')=>resource(id,'mcp',serializeMcpRegistration({version:1,connectionId:`connection-${id}`,endpointEnv:`FLOWLY_MCP_ENDPOINT_${id.toUpperCase()}`,tools:[{name:toolName,effect,description:'검증용 등록 도구',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}]}));
const docs=():Definition=>({schemaVersion:5,nodes:[{id:'read',type:'resource',title:'자료 읽기',x:0,y:0,resourceId:'old'},{id:'search',type:'retrieval',title:'자료 검색',x:0,y:100,retrieval:{resourceIds:['old'],topK:5,chunkSize:700,mode:'vector',indexKey:'test_index'}},{id:'index',type:'knowledge',title:'색인 검증',x:0,y:200,knowledge:{action:'evaluate',indexKey:'test_index',resourceIds:['old'],generationPath:'generation',evaluation:[{query:'정책',resourceId:'old'}]}}],edges:[{id:'e',source:'read',target:'search'}]});

test('material replacement updates document references and evaluation IDs while preserving source and settings',()=>{
 const graph=docs(),before=structuredClone(graph),resources=[resource('old'),resource('new')],resourcesBefore=structuredClone(resources);
 const next=rebindExampleResource(graph,'old','new',resources);
 assert.deepEqual(graph,before);assert.deepEqual(resources,resourcesBefore);assert.deepEqual(next.edges,graph.edges);
 assert.equal(next.nodes[0].resourceId,'new');assert.deepEqual(next.nodes[1].retrieval,{...graph.nodes[1].retrieval,resourceIds:['new']});
 assert.deepEqual(next.nodes[2].knowledge,{...graph.nodes[2].knowledge,resourceIds:['new'],evaluation:[{query:'정책',resourceId:'new'}]});
});

test('resource replacement requires same type and rejects unavailable or duplicate bindings without mutation',()=>{
 const graph=docs(),before=structuredClone(graph),resources=[resource('old'),resource('new','prompt')];
 assert.throws(()=>rebindExampleResource(graph,'old','new',resources),/같은 종류/);
 assert.throws(()=>rebindExampleResource(graph,'old','missing',resources),/사용할 수 없는/);
 assert.throws(()=>rebindExampleResource(graph,'missing','old',resources),/기존 자료의 종류/);
 assert.deepEqual(graph,before);
 graph.nodes[1].retrieval!.resourceIds.push('duplicate');
 assert.throws(()=>rebindExampleResource(graph,'old','duplicate',[resource('old'),resource('duplicate')]),/이미 연결/);
});

test('registered MCP replacements preserve tool names, arguments and nested approval paths',()=>{
 const original=mcp('old'),replacement=mcp('new'),selection={resourceId:'old',connectionId:'connection-old',toolName:'lookup'};
 const child:Definition={nodes:[{id:'call',type:'tool',title:'조회',x:0,y:0,allowedTools:[selection],tool:{arguments:{fixed:'keep'},bindings:{query:'text'}},onError:'branch'}],edges:[]};
 const graph:Definition={nodes:[{id:'agent',type:'agent',title:'Agent',x:0,y:0,allowedTools:[selection],limits:{maxToolCalls:2}},{id:'child',type:'subworkflow',title:'하위',x:0,y:100,subworkflow:{definition:child}}],edges:[]},before=structuredClone(graph);
 const next=rebindExampleResource(graph,'old','new',[original,replacement]);
 assert.deepEqual(graph,before);assert.deepEqual(next.nodes[0].allowedTools,[{...selection,resourceId:'new',connectionId:'connection-new'}]);
 assert.deepEqual(next.nodes[1].subworkflow!.definition.nodes[0],{...child.nodes[0],allowedTools:[{...selection,resourceId:'new',connectionId:'connection-new'}]});
 assert.equal(next.nodes[0].limits?.maxToolCalls,2);
});

test('MCP names, effects and input contracts cannot be silently substituted',()=>{
 const graph:Definition={nodes:[{id:'agent',type:'agent',title:'Agent',x:0,y:0,allowedTools:[{resourceId:'old',connectionId:'connection-old',toolName:'lookup'}]}],edges:[]};
 const old=mcp('old'),missing=mcp('other','write_record'),write=mcp('write','lookup','write'),legacy=resource('legacy','mcp','설명만 있는 연결');
 assert.match(exampleResourceReplacementIssue(graph,'old',missing,[old,missing])!,/필요한 도구/);
 assert.match(exampleResourceReplacementIssue(graph,'old',write,[old,write])!,/작업 종류 또는 입력 형식/);
 assert.match(exampleResourceReplacementIssue(graph,'old',legacy,[old,legacy])!,/도구 정의를 등록/);
 assert.throws(()=>rebindExampleResource(graph,'old','write',[old,write]),/작업 종류 또는 입력 형식/);
 const changed=mcp('changed');changed.content=changed.content.replace('"query"','"request"').replace('"query"','"request"');
 assert.match(exampleResourceReplacementIssue(graph,'old',changed,[old,changed])!,/작업 종류 또는 입력 형식/);
});

test('materials UI offers accessible same-type resources and explains missing definitions',()=>{
 const original=resource('old'),available=resource('mine'),prompt=resource('prompt','prompt');
 const merged=mergeExampleResources([available,prompt,{...original,name:'stale'}],[original]);
 assert.equal(merged.length,3);assert.equal(merged.find(item=>item.id==='old')?.name,'old');
 const html=renderToStaticMarkup(createElement(ExampleMaterials,{definition:docs(),resources:merged,onChange:()=>{}}));
 assert.match(html,/mine/);assert.doesNotMatch(html,/value="prompt"/);assert.match(html,/평가의 정답 자료 ID/);
 const missing=renderToStaticMarkup(createElement(ExampleMaterials,{definition:docs(),resources:[],onChange:()=>{}}));
 assert.match(missing,/기존 연결을 보존/);assert.match(missing,/disabled=""/);
});
