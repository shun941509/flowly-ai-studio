import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileDefinition} from '../domain/workflow';
import {validateGraph} from '../app/lib/model';
import {workflowIdentity} from '../domain/workflow-identity';
import {hasExplicitAgent} from '../domain/example-publication';
import {completion008034Designs as designs} from '../domain/workflow-designs/completion-008-034';
for(const design of designs)test(`${design.id}: valid explicit mappings and failure coverage`,()=>{
 const compiled=compileDefinition(design.definition);
 assert.deepEqual(validateGraph(compiled,design.resources),[]);
 assert.ok(design.scenarios.length>=2);
 assert.ok(design.acceptance.length>=3);
 assert.ok(design.scenarios.some(s=>s.status==='succeeded'));
 assert.ok(hasExplicitAgent(design.definition));
});
test('completed research graph structures are distinct',()=>{
 const signatures=designs.map(d=>workflowIdentity(d.definition).topology);
 assert.equal(new Set(signatures).size,designs.length);
});
