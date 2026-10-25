import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_CATALOG, TOOL_CANDIDATES, TOOL_FAMILIES, PLANNED_EXAMPLES, getToolsForExample, resolveToolCandidates } from '../domain/tool-catalog';
import { workflowDesigns } from '../domain/workflow-designs';
import { allNodes } from '../domain/advanced-config';
import { compileDefinition } from '../domain/workflow';
import { assertDistinctExamples } from '../domain/example-publication';
import { selectedPythonToolIds } from '../runtime/python-tools';

test('195 canonical candidate IDs occur once in 13 families and all 100 plans map symmetrically',()=>{
  assert.equal(TOOL_CATALOG.version,1);
  assert.equal(TOOL_CANDIDATES.length,195);
  assert.equal(new Set(TOOL_CANDIDATES.map(tool=>tool.id)).size,195);
  assert.deepEqual(TOOL_FAMILIES.map(family=>TOOL_CANDIDATES.filter(tool=>tool.family===family.id).length),[5,14,3,25,31,24,29,10,12,25,6,9,2]);
  assert.deepEqual(PLANNED_EXAMPLES.map(example=>example.id),Array.from({length:100},(_,i)=>String(i+1).padStart(3,'0')));
  const sources=new Set(workflowDesigns.map(design=>design.id));
  for(const example of PLANNED_EXAMPLES){
    assert.ok(example.families.length&&example.toolIds.length,example.id);
    assert.deepEqual(getToolsForExample(example.id).map(tool=>tool.id),example.toolIds,example.id);
    example.sourceIds.forEach(id=>assert.ok(sources.has(id),id));
    for(const sourceId of example.sourceIds)for(const toolId of selectedPythonToolIds(compileDefinition(workflowDesigns.find(design=>design.id===sourceId)!.definition)))assert.ok(example.toolIds.includes(toolId),`${example.id} must link the actual selected tool ${toolId}`);
    if(example.status==='구현됨')assert.ok(example.agentCriterionMet,`${example.id} must meet explicit Agent criterion`);
  }
  for(const tool of TOOL_CANDIDATES){assert.match(tool.id,/^[a-z][a-z0-9_]+$/);assert.ok(tool.exampleIds.length);assert.equal(tool.effect,'read');}
});

test('tool recommendations never expand the explicitly selected allowlist',()=>{
  assert.deepEqual(resolveToolCandidates(['bm25','bm25','jsonl']).map(tool=>tool.id),['bm25','jsonl']);
  assert.throws(()=>resolveToolCandidates(['__proto__']),/등록되지 않은/);
  assert.throws(()=>resolveToolCandidates(['shell']),/등록되지 않은/);
  const hybrid=workflowDesigns.find(design=>design.id==='integrated-007-hybrid-tools')!;
  const selected=selectedPythonToolIds(compileDefinition(hybrid.definition));
  assert.deepEqual(selected,['ai_citation','bm25','hybrid_search','semantic_search']);
  assert.ok(getToolsForExample('007').length>selected.length);
});

test('new integrations have meaningful Agent blocks, real tool use and distinct control flow',()=>{
  const integrated=workflowDesigns.filter(design=>design.id.startsWith('integrated-'));
  assert.ok(integrated.length>=7);
  assertDistinctExamples(workflowDesigns);
  for(const design of integrated){
    const definition=compileDefinition(design.definition);
    const agents=allNodes(definition).filter(node=>node.type==='agent');
    assert.ok(agents.length>0,design.id);
    assert.ok(agents.every(node=>Object.keys(node.inputBindings??{}).length>0&&node.prompt),design.id);
    assert.ok(design.scenarios.length>=2,design.id);
    assert.ok(design.scenarios.some(scenario=>scenario.modelReplies?.length),design.id);
  }
});
