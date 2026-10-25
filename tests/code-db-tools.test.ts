import assert from 'node:assert/strict';
import test from 'node:test';
import { codeDbToolDesigns } from '../domain/workflow-designs/code-db-tools';
import { compileDefinition } from '../domain/workflow';
import { allNodes } from '../domain/advanced-config';
import { workflowIdentity } from '../domain/workflow-identity';
import { readMcpRegistration } from '../domain/mcp-registration';

test('19 code/DB designs retain distinct control graphs and meaningful Agent inputs',()=>{
  assert.equal(codeDbToolDesigns.length,19);
  const identities=new Set<string>();
  for(const design of codeDbToolDesigns){
    const definition=compileDefinition(design.definition);
    const identity=workflowIdentity(definition);assert.ok(!identities.has(identity.topology),design.id);identities.add(identity.topology);
    const agents=allNodes(definition).filter(node=>node.type==='agent');
    assert.ok(agents.length>=2,design.id);
    assert.ok(agents.every(node=>Object.values(node.inputBindings??{}).length>0),design.id);
    assert.ok(design.scenarios.length>=2,design.id);
    assert.ok(design.resources.every(resource=>resource.url.endsWith('.invalid/mcp')),design.id);
  }
});

test('every selected MCP operation resolves to a registered contract; writes have denial and ambiguous-outcome evidence',()=>{
  for(const design of codeDbToolDesigns){
    const registration=readMcpRegistration(design.resources[0])!;
    assert.ok(registration.endpointEnv.startsWith('FLOWLY_MCP_ENDPOINT_'));
    for(const node of allNodes(design.definition))for(const selection of node.allowedTools??[]){
      assert.ok(registration.tools.some(tool=>tool.name===selection.toolName),`${design.id}/${selection.toolName}`);
      assert.equal(selection.resourceId,design.resources[0].id);
    }
    if(registration.tools.some(tool=>tool.effect==='write')){
      assert.ok(design.scenarios.some(scenario=>scenario.approval==='deny'&&scenario.status==='failed'),design.id);
      assert.ok(design.scenarios.some(scenario=>scenario.status==='unknown_outcome'&&scenario.resumeAgain),design.id);
    }
  }
});

test('parallel test, permission and privacy failures have deterministic checks before Agent promotion',()=>{
  for(const plan of ['071','075','086','090']){
    const design=codeDbToolDesigns.find(d=>d.id.startsWith(`integrated-${plan}-`))!;
    const checks=design.definition.nodes.filter(n=>n.program?.name==='goal_check');
    assert.ok(checks.length>0,design.id);
    for(const check of checks){
      assert.ok(Array.isArray(check.program!.arguments.checks));
      const next=design.definition.edges.find(edge=>edge.source===check.id)!;
      assert.equal(design.definition.nodes.find(n=>n.id===next.target)!.type,'merge');
    }
  }
  const build=codeDbToolDesigns.find(d=>d.id.startsWith('integrated-076-'))!;
  assert.ok(build.definition.nodes.some(n=>n.predicate?.path.includes('artifactHash')&&n.predicate.rightPath?.includes('artifactHash')));
});

test('schema recovery requires a separate write approval, independent check and explicit incomplete original goal',()=>{
  const migration=codeDbToolDesigns.find(d=>d.id.startsWith('integrated-083-'))!;
  const registration=readMcpRegistration(migration.resources[0])!;
  assert.equal(registration.tools.find(tool=>tool.name==='p083_restore_migration_backup')!.effect,'write');
  assert.equal(registration.tools.find(tool=>tool.name==='p083_verify_recovery')!.effect,'read');
  const scenario=migration.scenarios.find(s=>s.contains?.includes('recovered'))!;
  assert.equal(scenario.approval,'approve');
  assert.ok(scenario.contains!.includes('"originalGoalComplete":false'));
  assert.ok(scenario.resumeAgain);
});
