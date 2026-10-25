import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {completion035068Designs} from '../domain/workflow-designs/completion-035-068';
import {compileDefinition} from '../domain/workflow';
import {workflowIdentity} from '../domain/workflow-identity';
import {allNodes} from '../domain/advanced-config';
import metadata from '../domain/planned-completions/035-068.json';

test('32 completion designs map original requirements to unique graphs, meaningful Agents and boundary cases',()=>{
 assert.equal(completion035068Designs.length,32);
 assert.equal(metadata.length,32);
 const identities=new Set();
 for(const d of completion035068Designs){
  const compiled=compileDefinition(d.definition),identity=workflowIdentity(compiled);
  assert.ok(!identities.has(identity.topology),d.id);identities.add(identity.topology);
  assert.ok(d.scenarios.length>=2,d.id);
  assert.ok(allNodes(compiled).some(node=>node.type==='agent'&&Object.keys(node.inputBindings??{}).length>0),d.id);
  assert.ok(metadata.some(row=>row.sourceId===d.id&&row.acceptance.length&&row.remainingSetup.length),d.id);
 }
 assert.ok(!metadata.some(row=>['052','059'].includes(row.id)));
});

test('taskboard and avatar state use durable CAS; goal changes use first-match cancellation and affected-only execution',()=>{
 const find=(id:string)=>completion035068Designs.find(d=>d.id.startsWith('completed-'+id+'-'))!;
 assert.equal(find('042').definition.nodes.filter(node=>node.memory?.expectedRevisionPath).length,5);
 for(const id of ['062','064'])assert.ok(find(id).definition.nodes.some(node=>node.memory?.expectedRevisionPath));
 const goal=find('050');assert.ok(goal.definition.nodes.some(node=>node.parallel?.completion?.mode==='first_match'));
 assert.ok(goal.scenarios.some(s=>s.decisionSequence?.some(d=>d.kind==='accept')));
 assert.ok(goal.scenarios.some(s=>s.decisionSequence?.some(d=>d.kind==='reject')));
 for(const id of ['046','063']){
  const operations=allNodes(find(id).definition).map(node=>node.program?.arguments.operation);
  assert.ok(operations.includes('operations.code_patch'));assert.ok(operations.includes('operations.code_test'));
 }
});

test('registered technical algorithms reject invalid evidence and enforce actual transition semantics',()=>{
 const script=String.raw`
import sys,json
sys.path.insert(0,'export-runtime')
import completion_programs as p
e=p.execute
request={'domains':{'workers':[1,2,3],'hours':[1,2,3],'fixed':[7]},'rules':[{'id':'capacity','kind':'sum','fields':['workers','hours'],'min':5,'max':6}],'candidate':{'workers':1,'hours':1,'fixed':7},'mode':'repair'}
r=e('technical.constraints',request)
assert r['candidate']=={'workers':3,'hours':2,'fixed':7} and r['changedFields']==['hours','workers']
assert e('technical.constraints',dict(request,domains=dict(reversed(list(request['domains'].items())))))==r
request['rules'][0]['min']=9;request['rules'][0]['max']=10
assert not e('technical.constraints',request)['passed']
board={'revision':0,'tasks':{'analysis':{'status':'pending'},'implementation':{'status':'pending','dependsOn':['analysis']}}}
claim={'board':board,'expectedRevision':0,'taskId':'analysis','actor':'a','now':100,'leaseSeconds':10,'action':'claim'}
c=e('technical.taskboard_transition',claim);assert c['passed'] and c['board']['tasks']['analysis']['owner']=='a'
assert not e('technical.taskboard_transition',dict(claim,board=c['board']))['passed']
publish=dict(claim,board=c['board'],expectedRevision=1,action='publish',claimRevision=1,artifact={'summary':'evidence'})
assert not e('technical.taskboard_transition',dict(publish,actor='b'))['passed']
assert not e('technical.taskboard_transition',dict(publish,now=110))['passed']
done=e('technical.taskboard_transition',publish);assert done['readyTaskIds']==['implementation'] and done['board']['revision']==2
learning=e('technical.learning',{'learner':{'revision':0,'level':1,'attempts':0},'expected':'backup','answer':'BACKUP'})
assert learning['passed'] and learning['learner']['level']==2 and '<svg' in learning['avatar']['svg']
wrong=e('technical.learning',{'learner':learning['learner'],'expected':'backup','answer':'skip'})
assert not wrong['passed'] and wrong['learner']['level']==2
role=e('technical.roleplay',{'session':{'revision':0,'state':'intro'},'choice':'ask'})
assert role['session']['state']=='clarify'
assert not e('technical.roleplay',{'session':role['session'],'choice':'finish'})['passed']
cue=e('technical.avatar',{'caption':'<script>alert(1)</script>','checks':[{'answer':1,'expected':1}]})
assert '<script>' not in cue['avatar']['svg'] and '&lt;script&gt;' in cue['avatar']['svg']
assert not e('technical.citation',{'documents':[{'id':'a','text':'backup first'}],'answer':{'sourceId':'a','quote':'publish first'}})['passed']
assert not e('technical.cross_modal',{'claims':[{'position':'p1','regionId':'r','label':'server','count':2}],'observations':[{'regionId':'r','label':'server','count':2,'confidence':.2}]})['passed']
assert not e('technical.audit',{'approvals':[],'calls':[{'id':'c','effect':'write','tool':'x','arguments':{},'runId':'r','at':10}]})['passed']
source='@app.get("/items/{id}")\ndef item(id):\n    return id\n'
contract={'codeSource':source,'documents':[{'id':'d','symbol':'item','parameters':['id'],'method':'GET','path':'/items/{id}','exampleId':'example'}]}
assert e('technical.alignment',contract)['extraction']=='python_ast'
assert e('technical.alignment',contract)['passed']
assert not e('technical.alignment',dict(contract,codeSource=source.replace('def item(id)','def item(wrong)')))['passed']
assert not e('technical.migration',{'rows':[{'id':'a','amount':'wrong'}],'rename':{},'idField':'id','fieldTypes':{'amount':'number'}})['passed']
one={'events':[{'id':'a','time':10,'correlationKey':'service'}],'windowSeconds':10,'threshold':2}
first=e('technical.events',one)
second=e('technical.events',dict(first,events=[{'id':'b','time':12,'correlationKey':'service'}],windowSeconds=10,threshold=2))
assert first['passed'] and not second['passed'] and second['incidents'][0]['eventIds']==['a','b']
print(json.dumps({'passed':True,'externalCalls':0}))
`;
 const result=spawnSync(process.env.FLOWLY_PYTHON??'python',['-I','-X','utf8','-c',script],{encoding:'utf8',timeout:15000,windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).passed,true);
});
