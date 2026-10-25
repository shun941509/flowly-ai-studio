import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNodeRuntime } from "../domain/schema";
import { parseDataNodeConfig } from "../domain/node-config";
import { readPythonToolPreset } from "../domain/python-tool-preset";
import { compileDefinition, referencedResourceIds } from "../domain/workflow";
import { templateWorkflow, parseResource, validateGraph } from "../app/lib/model";
import { inspectWorkflow } from "../domain/preflight";

test("registered Python selections survive compilation and satisfy Agent tool requirement", () => {
  const workflow = templateWorkflow("agent");
  const agent = workflow.definition.nodes.find(node => node.type === "agent")!;
  agent.allowedTools = []; agent.pythonTools = ["bm25"]; agent.requireToolResult = true;
  workflow.definition = compileDefinition(workflow.definition);
  assert.deepEqual(workflow.definition.nodes.find(node => node.type === "agent")?.pythonTools, ["bm25"]);
  assert.deepEqual(validateGraph(workflow.definition), []);
  const check = inspectWorkflow(workflow, []);
  assert.equal(check.canExport, true);
  assert.ok(!check.issues.some(issue => issue.message.includes("선택한 도구가 없어")));
  assert.ok(check.issues.some(issue => issue.message.includes("Python")));
});

test("Python permissions reject unknown IDs, duplicate tools, non-Agent use and total limit", () => {
  assert.throws(() => parseNodeRuntime({ type: "agent", pythonTools: ["exec"] }));
  assert.throws(() => parseNodeRuntime({ type: "agent", pythonTools: ["bm25", "bm25"] }));
  assert.throws(() => parseNodeRuntime({ type: "ai", pythonTools: ["bm25"] }));
  assert.throws(() => parseNodeRuntime({ type: "agent", pythonTools: ["bm25"], allowedTools: Array.from({ length: 12 }, (_, i) => ({ resourceId: `r${i}`, connectionId: `c${i}`, toolName: `t${i}` })) }));
});

test("Python programs cannot bind their implementation from untrusted upstream output", () => {
  const program = { name: "python_tool", arguments: { toolId: "bm25", arguments: {} }, bindings: { arguments: "data" } };
  assert.equal(parseDataNodeConfig({ type: "program", program }).program?.arguments.toolId, "bm25");
  assert.throws(() => parseDataNodeConfig({ type: "program", program: { ...program, bindings: { toolId: "data.toolId" } } }));
  assert.throws(() => parseDataNodeConfig({ type: "program", program: { ...program, arguments: { toolId: "arbitrary_module" } } }));
  assert.throws(() => parseDataNodeConfig({ type: "program", program: { ...program, arguments: { toolId: "bm25", arguments: [] } } }));
});

test("Python presets preserve document resource permission references and reject code", () => {
  const content = JSON.stringify({ flowlyPython: { version: 1, toolId: "bm25", arguments: { query: "사내" } } });
  const preset = readPythonToolPreset({ type: "document", content });
  assert.equal(preset?.arguments.toolId, "bm25");
  assert.equal(readPythonToolPreset({ type: "document", content: "일반 자료" }), null);
  assert.throws(() => readPythonToolPreset({ type: "document", content: JSON.stringify({ flowlyPython: { version: 1, toolId: "bm25", code: "print(1)" } }) }));
  const resource = parseResource({ type: "document", name: "설정", content, visibility: "selected", allowedEmails: ["reader@example.test"] });
  assert.equal(resource.visibility, "selected");
  const workflow = templateWorkflow("blank");
  workflow.definition.nodes.push({ id: "tool", type: "program", title: "검색", x: 0, y: 200, resourceId: "private-preset", program: preset! });
  workflow.definition.edges = [{ id: "a", source: "input", target: "tool" }, { id: "b", source: "tool", target: "output" }];
  assert.ok(referencedResourceIds(compileDefinition(workflow.definition)).includes("private-preset"));
});
