import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { workflowDesigns } from "../domain/workflow-designs";
import { compileDefinition } from "../domain/workflow";
import { validateGraph } from "../app/lib/model";
import { workflowIdentity } from "../domain/workflow-identity";
import { canonical } from "./audit-examples";

const ids = new Set<string>(), executions = new Map<string,string>(), topologies = new Map<string,string>();
const definitions = workflowDesigns.map(design => {
  if(ids.has(design.id))throw new Error(`Duplicate workflow id: ${design.id}`); ids.add(design.id);
  const definition=compileDefinition(design.definition), errors=validateGraph(definition,design.resources);
  if(errors.length)throw new Error(`${design.id}: ${errors.join(" / ")}`);
  const identity=workflowIdentity(definition), duplicate=executions.get(identity.execution);
  if(duplicate)throw new Error(`Equivalent executable workflows: ${duplicate} / ${design.id}`);
  const sameTopology=topologies.get(identity.topology);
  if(sameTopology)throw new Error(`Repeated workflow structure belongs in cases, not independent designs: ${sameTopology} / ${design.id}`);
  topologies.set(identity.topology,design.id);
  executions.set(identity.execution,design.id);
  if(design.scenarios.length<2)throw new Error(`Normal and boundary scenarios required: ${design.id}`);
  const {scenarios:_scenarios,...publicDesign}=design; void _scenarios;
  return {...publicDesign,definition,designHash:createHash("sha256").update(canonical(design)).digest("hex"),topologyHash:createHash("sha256").update(identity.topology).digest("hex"),executionHash:createHash("sha256").update(identity.execution).digest("hex")};
});
await mkdir("domain/generated",{recursive:true});
await writeFile("domain/generated/workflow-designs.json",JSON.stringify(definitions,null,2)+"\n");
console.log(`Authored ${definitions.length} executable workflows; topology groups ${new Set(definitions.map(d=>d.topologyHash)).size}. Text-only cases are not counted.`);
