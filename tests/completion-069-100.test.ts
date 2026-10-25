import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { completion069To100Designs, completion069To100Specs } from '../domain/workflow-designs/completion-069-100';
import { compileDefinition } from '../domain/workflow';
import { allNodes } from '../domain/advanced-config';
import { workflowIdentity } from '../domain/workflow-identity';
import { nodeNames } from '../app/lib/model';

test('29 planned operations examples compile, contain Agents and have distinct meaningful typed graphs', () => {
  assert.equal(completion069To100Designs.length, 29);
  assert.deepEqual(completion069To100Designs.map(d=>Number(d.id.slice(10,13))).sort((a,b)=>a-b),Array.from({length:32},(_,i)=>69+i).filter(n=>![97,98,99].includes(n)));
  const topologies=new Set<string>();
  for(const design of completion069To100Designs){
    const graph=compileDefinition(design.definition);
    assert.ok(allNodes(graph).some(node=>node.type==='agent'),design.id);
    const identity=workflowIdentity(graph);
    assert.ok(!topologies.has(identity.topology),design.id);topologies.add(identity.topology);
    assert.ok(design.scenarios.length>=2);
  }
});

test('all-block project contains each supported block and explicit compensation, denial, input and resume scenarios',()=>{
  const design=completion069To100Designs.find(d=>d.id.startsWith('completed-095-'))!;
  assert.deepEqual(new Set(allNodes(design.definition).map(n=>n.type)),new Set(Object.keys(nodeNames)));
  assert.ok(design.scenarios.some(s=>s.approval==='deny'));
  assert.ok(design.scenarios.some(s=>s.visited?.includes('c095_compensate')));
  assert.ok(design.scenarios.some(s=>s.inputSubmissions?.length&&s.resumeAgain));
});

const python=existsSync(resolve('work/tools-env/Scripts/python.exe'))?resolve('work/tools-env/Scripts/python.exe'):'python';
const driver=String.raw`import json,runpy,sys
module=runpy.run_path(sys.argv[1])
boundary=runpy.run_path(str(__import__('pathlib').Path(sys.argv[1]).with_name('flowly_completions.py')))['bounded']
operations=module['OPERATIONS']
cases=json.load(sys.stdin)
result=[]
for case in cases:
    record=case['input']
    record['proposal']={'proceed':True,'action':case['action'],'reason':'boundary test'}
    for step in case['steps']:
        if isinstance(step,str): record=boundary(operations['operations.'+step](record))
        elif 'parallel' in step:
            children=[{'taskId':name,'output':{'data':boundary(operations['operations.'+name](record))}} for name in step['parallel']]
            record=operations['operations.collect_evidence']({'record':record,'checks':children})
        elif 'gate' in step and not record.get('passed'): break
    else: record=operations['operations.final_verify'](record)
    result.append({'id':case['id'],'passed':record.get('passed'),'operations':[r['operation'] for r in record.get('ledger',[])]})
print(json.dumps(result))`;

test('registered project algorithms compute normal and substantive failure results without model/MCP answers',()=>{
  // Browser is exercised by actual exported CLI scenarios and its dedicated
  // dependency check; this fast arithmetic/SQLite suite has no optional packages.
  const specs=completion069To100Specs.filter(s=>s.number!=='075');
  const cases=specs.flatMap(spec=>[{id:spec.number+' normal',input:spec.input??{},action:spec.action??'fix_average',steps:spec.steps},{id:spec.number+' failure',input:{...spec.input,...spec.bad},action:spec.badAction??spec.action??'fix_average',steps:spec.steps}]);
  const output=execFileSync(python,['-X','utf8','-I','-c',driver,resolve('export-runtime/completion_operations.py')],{input:JSON.stringify(cases),encoding:'utf8',timeout:90000,maxBuffer:3_000_000,windowsHide:true,env:{NODE_ENV:'test',SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:process.env.PATH}});
  const results=JSON.parse(output) as {id:string;passed:boolean;operations:string[]}[];
  for(const result of results)assert.equal(result.passed,result.id.endsWith('normal'),JSON.stringify(result));
});

test('registered source cannot be replaced with uploaded Python and SQLite plan hashes are enforced',()=>{
  const code=String.raw`import json,runpy,sys
m=runpy.run_path(sys.argv[1]); op=m['OPERATIONS']; errors=[]
for name,args in [('operations.code_test',{'candidateVersion':'fixed','candidateFiles':{'average.py':'print("arbitrary")'}}),('operations.db_apply',{'changePlan':{'operation':'add_status'},'planHash':'forged'})]:
 try: op[name](args)
 except ValueError as e: errors.append(str(e))
print(json.dumps(errors))`;
  const errors=JSON.parse(execFileSync(python,['-X','utf8','-I','-c',code,resolve('export-runtime/completion_operations.py')],{encoding:'utf8',windowsHide:true,timeout:10000}));
  assert.equal(errors.length,2);assert.match(errors[0],/uploaded/);assert.match(errors[1],/hash mismatch/);
});

test('lineage invalidation executes only affected steps and preserves dependency versions',()=>{
  const code=String.raw`import json,runpy,sys
m=runpy.run_path(sys.argv[1]); op=m['OPERATIONS']
state=op['operations.lineage_plan']({'values':[2,4,6],'previousGoal':{'version':1,'threshold':3},'goal':{'version':2,'threshold':5}})
for key in ['sum','mean','decision','report']:
 prefix='execute_' if state['lineage']['changed'][key] else 'reuse_'
 state=op['operations.lineage_'+prefix+key](state)
state=op['operations.lineage_verify'](state)
print(json.dumps({'passed':state['passed'],'executed':state['executedSteps'],'reused':state['reusedSteps'],'decision':state['stepArtifacts']['decision']}))`;
  const result=JSON.parse(execFileSync(python,['-X','utf8','-I','-c',code,resolve('export-runtime/completion_operations.py')],{encoding:'utf8',windowsHide:true,timeout:10000}));
  assert.deepEqual(result,{passed:true,executed:['decision','report'],reused:['sum','mean'],decision:false});
});

test('completion metadata identifies each implemented source plan and retains setup boundaries',()=>{
  const entries=JSON.parse(readFileSync(resolve('domain/planned-completions/069-100.json'),'utf8')) as {id:string;sourceId:string;acceptance:string[];implementedScope:string;remainingSetup:string[]}[];
  assert.equal(entries.length,29);
  for(const design of completion069To100Designs){const entry=entries.find(e=>e.sourceId===design.id);assert.ok(entry);assert.ok(entry.acceptance.length&&entry.implementedScope&&entry.remainingSetup.length);}
});

test('board roles enforce dependency, claim version and independent artifact verification',()=>{
  const code=String.raw`import json,runpy,sys,copy
op=runpy.run_path(sys.argv[1])['OPERATIONS']
board={'revision':0,'tasks':{'analysis':{'status':'pending'},'verification':{'status':'pending'}},'artifacts':{}}
def claim(board,role,revision): return op['operations.board_claim']({'record':{'values':[2,4,6],'expectedRevision':revision,'proposal':{'action':role}},'board':board})
premature=claim(board,'verification',0)
s=claim(board,'analysis',0)
s=op['operations.board_commit'](op['operations.board_work'](s))
assert s['passed'] and s['evidence']['goalComplete'] is False
board=s['board']; stale=claim(board,'verification',0)
s=claim(board,'verification',2); s=op['operations.board_work'](s)
tampered=copy.deepcopy(s);tampered['board']['artifacts']['analysis']['revision']=9
rejected=op['operations.board_commit'](tampered)
s=op['operations.board_commit'](s)
print(json.dumps({'premature':premature['passed'],'stale':stale['passed'],'tampered':rejected['passed'],'complete':s['evidence']['goalComplete'],'revision':s['board']['revision']}))`;
  const result=JSON.parse(execFileSync(python,['-X','utf8','-I','-c',code,resolve('export-runtime/completion_operations.py')],{encoding:'utf8',windowsHide:true,timeout:10000}));
  assert.deepEqual(result,{premature:false,stale:false,tampered:false,complete:true,revision:4});
});
