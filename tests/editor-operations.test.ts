import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFragment,canApplyClipboard,disconnectedInputs,EditorHistory,moveSelection,nodesInRect,parseEditorFragment,removeSelection,screenToWorld,selectionFragment,selectionRect,zoomAt} from '../domain/editor-operations';
import type {Definition} from '../app/lib/model';

const flow=():Definition=>({schemaVersion:5,nodes:[
 {id:'input',type:'input',title:'입력',x:0,y:0},
 {id:'agent',type:'agent',title:'판단',x:40,y:200,prompt:'근거를 확인',allowedTools:[],inputBindings:{text:{nodeId:'input',path:'text'}}},
 {id:'output',type:'output',title:'출력',x:80,y:400,inputBindings:{text:{nodeId:'agent',path:'text'}}},
],edges:[{id:'ia',source:'input',target:'agent'},{id:'ao',source:'agent',target:'output'}]});
const idFactory=()=>{let index=0;return(prefix:string)=>`${prefix}_copy_${++index}`;};
test('pointer zoom preserves the exact world point under the cursor at all scales',()=>{
 for(const initial of [.03,.8,1.6]){const view={x:-123,y:71,zoom:initial},pointer={x:245,y:130},before=screenToWorld(pointer,view);for(const next of [.001,.2,1,10]){const result=zoomAt(view,pointer,next),after=screenToWorld(pointer,result);assert.ok(Math.abs(before.x-after.x)<1e-9);assert.ok(Math.abs(before.y-after.y)<1e-9);assert.ok(result.zoom>=.03&&result.zoom<=1.6);}}
});
test('marquee works in either direction and selects intersecting node bounds',()=>{
 const rectangle=selectionRect({x:300,y:350},{x:30,y:180});
 assert.deepEqual(nodesInRect(flow().nodes,rectangle),['agent']);
 assert.deepEqual(rectangle,{x:30,y:180,width:270,height:170});
});
test('group movement keeps spacing at coordinate limits and leaves other nodes unchanged',()=>{
 const d=flow(),next=moveSelection(d,['agent','output'],{x:99999,y:-99999});
 assert.equal(next.nodes[2].x-next.nodes[1].x,40);assert.equal(next.nodes[2].y-next.nodes[1].y,200);
 assert.equal(next.nodes[2].x,10000);assert.equal(next.nodes[1].y,-10000);assert.deepEqual(next.nodes[0],d.nodes[0]);assert.equal(d.nodes[1].x,40);
});
test('copy/paste remaps internal edges and explicit bindings, preserving external references as reconnectable',()=>{
 const d=flow(),snapshot=structuredClone(d),fragment=selectionFragment(d,['agent','output']);
 const pasted=appendFragment(d,parseEditorFragment(JSON.stringify(fragment)),idFactory(),{x:500,y:600});
 const [a,b]=pasted.definition.nodes.slice(-2),edge=pasted.definition.edges.at(-1)!;
 assert.equal(edge.source,a.id);assert.equal(edge.target,b.id);assert.equal(b.inputBindings?.text.nodeId,a.id);
 assert.equal(a.inputBindings?.text.nodeId,'input');assert.deepEqual(disconnectedInputs(pasted.definition,a),['text']);assert.deepEqual(disconnectedInputs(pasted.definition,b),[]);
 assert.equal(a.x,500);assert.equal(a.y,600);assert.equal(b.x-a.x,40);assert.equal(b.y-a.y,200);
 assert.deepEqual(d,snapshot);a.allowedTools?.push({resourceId:'new',connectionId:'new',toolName:'new'});assert.deepEqual(d.nodes[1].allowedTools,[]);
});
test('legacy implicit inputs are materialized before copying so partial copies cannot silently change data flow',()=>{
 const d=flow();delete d.nodes[1].inputBindings;delete d.nodes[2].inputBindings;
 const result=appendFragment(d,selectionFragment(d,['agent','output']),idFactory());
 assert.equal(result.definition.nodes.at(-1)?.inputBindings?.text.nodeId,result.ids[0]);
 assert.deepEqual(disconnectedInputs(result.definition,result.definition.nodes.at(-2)!),['text']);
});
test('group delete leaves explicit missing inputs visible and removes every incident edge',()=>{
 const d=flow(),next=removeSelection(d,['agent']);assert.deepEqual(next.edges,[]);
 assert.deepEqual(disconnectedInputs(next,next.nodes.find(n=>n.id==='output')!),['text']);
 assert.equal(next.nodes.find(n=>n.id==='output')?.inputBindings?.text.nodeId,'agent');assert.equal(d.nodes.length,3);
});
test('legacy implicit inputs retain original field names when deleting their primary source or an edge',()=>{
 const d=flow();delete d.nodes[2].inputBindings;d.edges.push({id:'io',source:'input',target:'output'});
 for(const next of [removeSelection(d,['agent']),removeSelection(d,[],['ao'])]){
  const output=next.nodes.find(n=>n.id==='output')!;
  assert.deepEqual(output.inputBindings,{text:{nodeId:'agent',path:'text'},context_1:{nodeId:'input',path:'text'}});
  assert.deepEqual(disconnectedInputs(next,output),['text']);
 }
 assert.equal(d.nodes[2].inputBindings,undefined);
});
test('start and document limits reject a whole paste without partial mutation',()=>{
 const d=flow(),before=JSON.stringify(d);assert.throws(()=>appendFragment(d,selectionFragment(d,['input','agent']),idFactory()),/시작 블록/);assert.equal(JSON.stringify(d),before);
 const many={...d,nodes:[...d.nodes,...Array.from({length:36},(_,i)=>({id:`n${i}`,type:'output' as const,title:'결과',x:0,y:0}))]};
 assert.throws(()=>appendFragment(many,selectionFragment(d,['agent','output']),idFactory()),/40개/);assert.equal(many.nodes.length,39);
 const empty:Definition={schemaVersion:5,nodes:[],edges:[]};assert.equal(appendFragment(empty,selectionFragment(d,['input']),idFactory()).definition.nodes.length,1);
});
test('untrusted clipboard data is parsed and validated before appending',()=>{
 assert.throws(()=>parseEditorFragment('not JSON'));
 assert.throws(()=>parseEditorFragment(JSON.stringify({kind:'other',version:1,definition:flow()})));
 assert.throws(()=>parseEditorFragment(JSON.stringify({kind:'flowly-selection',version:1,definition:{...flow(),nodes:[{...flow().nodes[0],x:Infinity}]}})));
 assert.throws(()=>parseEditorFragment(JSON.stringify({kind:'flowly-selection',version:1,definition:{...flow(),edges:[{id:'x',source:'missing',target:'agent'}]}})));
 assert.throws(()=>parseEditorFragment(' '.repeat(2_000_001)));
});
test('an asynchronous clipboard result cannot overwrite a gesture or a newer document',()=>{
 const snapshot={workflowId:'one',definition:flow()};
 assert.equal(canApplyClipboard(snapshot,snapshot,false),true);
 assert.equal(canApplyClipboard(snapshot,snapshot,true),false);
 assert.equal(canApplyClipboard(snapshot,{...snapshot,workflowId:'two'},false),false);
 assert.equal(canApplyClipboard(snapshot,{...snapshot,definition:moveSelection(snapshot.definition,['agent'],{x:1,y:0})},false),false);
});
test('one group gesture is one undo transaction; new edits clear redo and no-op selections do not enter history',()=>{
 const history=new EditorHistory(),initial=flow(),after=moveSelection(initial,['agent','output'],{x:30,y:50});
 assert.equal(history.record(initial,initial),false);assert.equal(history.past.length,0);
 history.record(initial,after);assert.equal(history.past.length,1);assert.deepEqual(history.undo(after),initial);assert.deepEqual(history.redo(initial),after);
 const undone=history.undo(after)!;history.record(undone,removeSelection(undone,['output']));assert.equal(history.future.length,0);
 for(let i=0;i<60;i++)history.record(initial,after);assert.equal(history.past.length,50);
 history.reset();assert.equal(history.undo(after),null);assert.equal(history.redo(after),null);
});
