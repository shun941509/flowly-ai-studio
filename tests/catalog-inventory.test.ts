import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCatalogPublication } from "../scripts/catalog-publication-summary";
import { workflowDesigns } from "../domain/workflow-designs";
import { hasExplicitAgent } from "../domain/example-publication";
import published from "../domain/generated/workflow-designs.json";

test("inventory keeps source coverage separate from Agent target without inventing evidence", () => {
  const records = published.map(record => ({ ...record, hasAgent: hasExplicitAgent(workflowDesigns.find(design => design.id === record.id)!.definition), verified: false }));
  const summary = summarizeCatalogPublication(records, 3200);
  assert.equal(summary.source.graphs, 227);
  assert.equal(summary.publication.agentExamples, 156);
  assert.equal(summary.publication.supportingFlows, 71);
  assert.equal(summary.publication.remainingAgentExamples, 3044);
  assert.equal(summary.source.verifiedGraphs, 0);
  assert.equal(summary.publication.verifiedAgentExamples, 0);
  assert.equal(summary.publication.targetReached, false);
});

test("verified supporting flows and duplicate Agent structures do not advance Agent completion", () => {
  const records = [
    { id: "agent-a", hasAgent: true, topologyHash: "same", executionHash: "one", verified: true },
    { id: "agent-b", hasAgent: true, topologyHash: "same", executionHash: "two", verified: false },
    { id: "support", hasAgent: false, topologyHash: "support", executionHash: "support", verified: true },
  ];
  const summary = summarizeCatalogPublication(records, 2);
  assert.equal(summary.source.verifiedGraphs, 2);
  assert.equal(summary.publication.verifiedAgentExamples, 1);
  assert.equal(summary.publication.verifiedSupportingFlows, 1);
  assert.equal(summary.publication.remainingAgentExamples, 1);
  assert.equal(summary.publication.targetReached, false);
  assert.throws(() => summarizeCatalogPublication([...records, records[0]], 2), /중복/);
  assert.throws(() => summarizeCatalogPublication(records, 0), /양의 정수/);
});
