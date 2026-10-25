import test from "node:test";
import assert from "node:assert/strict";
import type { Definition, FlowNode } from "../app/lib/model";
import { groupWorkflowIdentities, workflowIdentity } from "../domain/workflow-identity";
import { evaluatePredicate } from "../domain/predicate";

const node = (id: string, type: FlowNode["type"], config: Partial<FlowNode> = {}): FlowNode => ({ id, type, title: id, x: 0, y: 0, ...config });
function chain(middle: FlowNode[]): Definition {
  const nodes = [node("input", "input"), ...middle, node("output", "output")];
  return { schemaVersion: 5, nodes, edges: nodes.slice(1).map((current, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: current.id })) };
}
function example(): Definition {
  const graph = chain([node("facts", "resource", { resourceId: "doc-a" }), node("answer", "agent", { prompt: "정책을 설명하세요", inputBindings: { text: { nodeId: "input", path: "text" }, context_1: { nodeId: "facts", path: "text" } }, allowedTools: [], limits: { maxTurns: 2 } })]);
  graph.edges.push({ id: "request", source: "input", target: "answer" });
  graph.nodes.at(-1)!.inputBindings = { text: { nodeId: "answer", path: "text" } };
  return graph;
}
function renamed(graph: Definition, prefix: string): Definition {
  const copy = structuredClone(graph), mapping = new Map(copy.nodes.map(current => [current.id, `${prefix}-${current.id}`]));
  for (const current of copy.nodes) {
    current.id = mapping.get(current.id)!; current.title = "다른 이름"; current.description = "다른 설명"; current.prompt = "다른 업종과 업무에 관한 지시";
    current.x += 200; current.y -= 100;
    if (current.resourceId) current.resourceId = prefix + "-document";
    for (const binding of Object.values(current.inputBindings ?? {})) binding.nodeId = mapping.get(binding.nodeId)!;
    if (current.compensation) current.compensation.sourceNodeId = mapping.get(current.compensation.sourceNodeId)!;
    if (current.retrieval) current.retrieval.resourceIds = current.retrieval.resourceIds.map((_, index) => `${prefix}-doc-${index}`);
    if (current.allowedTools) current.allowedTools = current.allowedTools.map(tool => ({ ...tool, resourceId: prefix + tool.resourceId, connectionId: prefix + tool.connectionId }));
    for (const config of [current.parallel, current.team, current.orchestration]) for (const task of config?.tasks ?? []) { task.id = prefix + task.id; task.name = "바뀐 역할 이름"; task.definition = renamed(task.definition, prefix); }
    for (const config of [current.loop, current.subworkflow]) if (config) config.definition = renamed(config.definition, prefix);
  }
  copy.nodes.reverse();
  copy.edges = copy.edges.map((edge, index) => ({ ...edge, id: `${prefix}-edge-${index}`, source: mapping.get(edge.source)!, target: mapping.get(edge.target)! })).reverse();
  return copy;
}

test("IDs, presentation, prompts, document references and array order do not create implementations", () => {
  const original = example(), before = JSON.stringify(original), copy = renamed(original, "translated");
  Object.assign(original.nodes[2], { modelName: "model-a" }); Object.assign(copy.nodes.find(current => current.type === "agent")!, { modelName: "model-b" });
  assert.deepEqual(workflowIdentity(original), workflowIdentity(copy));
  delete (original.nodes[2] as FlowNode & { modelName?: string }).modelName;
  assert.equal(JSON.stringify(original), before, "the comparison must not mutate graph data");
});

test("3,200 prompt-only variants collapse into one implementation group", () => {
  const original = example();
  const entries = Array.from({ length: 3_200 }, (_, index) => ({ id: `case-${String(index).padStart(4, "0")}`, definition: renamed(original, `renamed-${index}`) }));
  const groups = groupWorkflowIdentities(entries);
  assert.equal(groups.length, 1); assert.equal(groups[0].ids.length, 3_200);
  assert.deepEqual(groups[0].ids, entries.map(entry => entry.id));
});

test("bindings preserve source identity, destination ports and source paths", () => {
  const base = example(), baseIdentity = workflowIdentity(base);
  for (const mutate of [
    (graph: Definition) => { graph.nodes[2].inputBindings!.context_1.nodeId = "input"; },
    (graph: Definition) => { graph.nodes[2].inputBindings!.context_1.path = "data"; },
    (graph: Definition) => { graph.nodes[2].inputBindings!.context_2 = graph.nodes[2].inputBindings!.context_1; delete graph.nodes[2].inputBindings!.context_1; },
  ]) {
    const changed = structuredClone(base); mutate(changed);
    assert.equal(workflowIdentity(changed).topology, baseIdentity.topology);
    assert.notEqual(workflowIdentity(changed).execution, baseIdentity.execution);
  }
});

test("directed connections, branch routes and condition values are preserved", () => {
  const a = chain([node("a", "resource"), node("b", "agent")]);
  const b = chain([node("b", "agent"), node("a", "resource")]);
  assert.notEqual(workflowIdentity(a).topology, workflowIdentity(b).topology);
  const branching: Definition = { nodes: [node("i", "input"), node("c", "condition", { condition: "approved" }), node("a", "agent"), node("t", "transform", { transform: { mode: "parse_json" } }), node("o", "output")], edges: [
    { id: "1", source: "i", target: "c" }, { id: "2", source: "c", target: "a", branch: "yes" }, { id: "3", source: "c", target: "t", branch: "no" }, { id: "4", source: "a", target: "o" }, { id: "5", source: "t", target: "o" },
  ] };
  const routeChange = structuredClone(branching); routeChange.edges[1].branch = "no"; routeChange.edges[2].branch = "yes";
  assert.notEqual(workflowIdentity(branching).execution, workflowIdentity(routeChange).execution);
  const predicateChange = structuredClone(branching); predicateChange.nodes[1].condition = "rejected";
  assert.equal(workflowIdentity(branching).topology, workflowIdentity(predicateChange).topology);
  assert.notEqual(workflowIdentity(branching).execution, workflowIdentity(predicateChange).execution);
});

test("classification IDs may be renamed consistently but routing must stay attached", () => {
  const graph: Definition = { nodes: [node("i", "input"), node("c", "classify", { classification: { labels: [{ id: "alpha", name: "A", description: "" }, { id: "beta", name: "B", description: "" }] } }), node("a", "agent"), node("t", "transform", { transform: { mode: "parse_json" } }), node("o", "output")], edges: [
    { id: "1", source: "i", target: "c" }, { id: "2", source: "c", target: "a", branch: "alpha" }, { id: "3", source: "c", target: "t", branch: "beta" }, { id: "4", source: "a", target: "o" }, { id: "5", source: "t", target: "o" },
  ] };
  const copy = structuredClone(graph); copy.nodes[1].classification!.labels[0].id = "first"; copy.nodes[1].classification!.labels[1].id = "second"; copy.edges[1].branch = "first"; copy.edges[2].branch = "second";
  assert.deepEqual(workflowIdentity(graph), workflowIdentity(copy));
  copy.edges[1].branch = "second"; copy.edges[2].branch = "first";
  assert.notEqual(workflowIdentity(graph).execution, workflowIdentity(copy).execution);
});

test("typed predicates retain paths, operators and values, including equality boundaries", () => {
  const base = chain([node("compare", "condition", { predicate: { path: "data.stock", operator: "lt", rightPath: "data.threshold" } })]);
  const identity = workflowIdentity(base);
  const boundary = { data: { stock: 8, threshold: 8, alternate: 9 } };
  assert.equal(evaluatePredicate(base.nodes[1].predicate!, boundary), false);
  assert.equal(evaluatePredicate(base.nodes[1].predicate!, { data: { stock: 7, threshold: 8 } }), true);
  assert.equal(evaluatePredicate(base.nodes[1].predicate!, { data: { stock: 9, threshold: 8 } }), false);
  for (const [predicate, expected] of [
    [{ path: "data.stock", operator: "lte", rightPath: "data.threshold" }, true],
    [{ path: "data.stock", operator: "lt", rightPath: "data.alternate" }, true],
    [{ path: "data.alternate", operator: "lt", rightPath: "data.threshold" }, false],
    [{ path: "data.stock", operator: "lt", value: 9 }, true],
    [{ path: "data.stock", operator: "lt", value: 8 }, false],
  ] as const) {
    const changed = structuredClone(base); changed.nodes[1].predicate = predicate;
    assert.equal(workflowIdentity(changed).topology, identity.topology);
    assert.notEqual(workflowIdentity(changed).execution, identity.execution);
    assert.equal(evaluatePredicate(predicate, boundary), expected);
  }
  const values = [8, 9].map(value => chain([node("compare", "condition", { predicate: { path: "data.stock", operator: "lt", value } })]));
  assert.notEqual(workflowIdentity(values[0]).execution, workflowIdentity(values[1]).execution);
  assert.throws(() => evaluatePredicate(base.nodes[1].predicate!, { data: { stock: "8", threshold: 8 } }), /숫자/);
  assert.throws(() => evaluatePredicate(base.nodes[1].predicate!, { data: { stock: 8 } }), /없어요/);
});

test("transform, memory, retrieval, tool arguments, schemas and budgets are executable settings", () => {
  const configurations: [FlowNode, FlowNode][] = [
    [node("n", "transform", { transform: { mode: "pick", fields: { value: "data.a" } } }), node("n", "transform", { transform: { mode: "parse_json" } })],
    [node("n", "memory", { memory: { action: "read", key: "history" } }), node("n", "memory", { memory: { action: "delete", key: "history" } })],
    [node("n", "retrieval", { retrieval: { resourceIds: ["a"], mode: "lexical", topK: 3, chunkSize: 900 } }), node("n", "retrieval", { retrieval: { resourceIds: ["b"], mode: "vector", topK: 3, chunkSize: 900 } })],
    [node("n", "tool", { tool: { arguments: { operation: "get", id: "one" }, bindings: {} } }), node("n", "tool", { tool: { arguments: { operation: "delete", id: "one" }, bindings: {} } })],
    [node("n", "agent", { outputSchema: { type: "string" } }), node("n", "agent", { outputSchema: { type: "number" } })],
    [node("n", "agent", { limits: { maxTurns: 2 } }), node("n", "agent", { limits: { maxTurns: 8 } })],
  ];
  for (const [a, b] of configurations) {
    assert.equal(workflowIdentity(chain([a])).topology, workflowIdentity(chain([b])).topology);
    assert.notEqual(workflowIdentity(chain([a])).execution, workflowIdentity(chain([b])).execution);
  }
  const tool = chain([node("tool", "tool", { allowedTools: [{ resourceId: "a", connectionId: "a", toolName: "lookup" }], tool: { arguments: { id: "record-a" }, bindings: {} } })]);
  assert.deepEqual(workflowIdentity(tool), workflowIdentity(renamed(tool, "other")));
  const changedArgument = structuredClone(tool); changedArgument.nodes[1].tool!.arguments.id = "record-b";
  assert.notEqual(workflowIdentity(tool).execution, workflowIdentity(changedArgument).execution, "payload IDs are values, not decorative node IDs");
});

test("every composite carries its child's structure and settings; task order is observable", () => {
  const first = chain([node("n", "transform", { transform: { mode: "parse_json" } })]);
  const second = chain([node("n", "memory", { memory: { action: "read", key: "state" } })]);
  const tasks = [{ id: "first", name: "첫 작업", definition: first }, { id: "second", name: "둘째 작업", definition: second }];
  const composites = [
    node("p", "parallel", { parallel: { tasks, concurrency: 2 } }),
    node("p", "agent_team", { team: { tasks, concurrency: 1, mode: "sequential" } }),
    node("p", "orchestrator", { orchestration: { tasks, maxTasks: 2, mode: "adaptive", maxRounds: 2 } }),
    node("p", "subworkflow", { subworkflow: { definition: first } }),
    node("p", "loop", { loop: { definition: first, itemsPath: "data.items", maxItems: 4, concurrency: 2 } }),
  ];
  for (const composite of composites) {
    const graph = chain([composite]), identity = workflowIdentity(graph);
    assert.deepEqual(identity, workflowIdentity(renamed(graph, "all-ids")));
    const changed = structuredClone(graph), parent = changed.nodes[1];
    const children = parent.parallel?.tasks ?? parent.team?.tasks ?? parent.orchestration?.tasks;
    if (children) children.reverse();
    else (parent.subworkflow ?? parent.loop)!.definition = second;
    assert.notEqual(identity.execution, workflowIdentity(changed).execution);
  }
  const loop = chain([composites[4]]), changed = structuredClone(loop); changed.nodes[1].loop!.itemsPath = "data.other";
  assert.notEqual(workflowIdentity(loop).execution, workflowIdentity(changed).execution);
  const team = chain([composites[1]]), parallelTeam = structuredClone(team); parallelTeam.nodes[1].team!.mode = "parallel";
  assert.notEqual(workflowIdentity(team).execution, workflowIdentity(parallelTeam).execution);
});

test("compensation source references follow ID renames and preserve the selected operation", () => {
  const graph = chain([node("first", "tool"), node("second", "tool"), node("undo", "compensate", { compensation: { sourceNodeId: "first", arguments: {}, bindings: {} } })]);
  assert.deepEqual(workflowIdentity(graph), workflowIdentity(renamed(graph, "new")));
  const changed = structuredClone(graph); changed.nodes[3].compensation!.sourceNodeId = "second";
  assert.notEqual(workflowIdentity(graph).execution, workflowIdentity(changed).execution);
});

function regularBipartite(split: boolean): Definition {
  const nodes = [node("input", "input"), ...Array.from({ length: 6 }, (_, index) => node(`l${index}`, "transform", { transform: { mode: "parse_json" } })), ...Array.from({ length: 6 }, (_, index) => node(`r${index}`, "merge", { merge: { mode: "array" } })), node("output", "output")];
  const links: [string, string][] = [];
  for (let index = 0; index < 6; index++) {
    const next = split ? Math.floor(index / 3) * 3 + (index + 1) % 3 : (index + 1) % 6;
    links.push(["input", `l${index}`], [`l${index}`, `r${index}`], [`l${index}`, `r${next}`], [`r${index}`, "output"]);
  }
  return { nodes, edges: links.map(([source, target], index) => ({ id: `e${index}`, source, target })) };
}
test("equal color-refinement histograms do not merge non-isomorphic incidence graphs", () => {
  const connectedCycle = regularBipartite(false), twoCycles = regularBipartite(true);
  // Both have six degree-two left and right vertices, with a shared start/end.
  // A refinement-only fingerprint cannot distinguish these incidence structures.
  assert.notEqual(workflowIdentity(connectedCycle).topology, workflowIdentity(twoCycles).topology);
  assert.deepEqual(workflowIdentity(connectedCycle), workflowIdentity(renamed(connectedCycle, "permutation")));
  assert.deepEqual(workflowIdentity(twoCycles), workflowIdentity(renamed(twoCycles, "permutation")));
  let random = 123456;
  for (let attempt = 0; attempt < 8; attempt++) {
    const permuted = renamed(connectedCycle, `seed-${attempt}`);
    for (const collection of [permuted.nodes, permuted.edges]) for (let index = collection.length - 1; index > 0; index--) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const other = random % (index + 1);
      [collection[index], collection[other]] = [collection[other], collection[index]];
    }
    assert.deepEqual(workflowIdentity(connectedCycle), workflowIdentity(permuted));
  }
});

test("large sets of exact twins are canonicalized without factorial enumeration", () => {
  const nodes = [node("input", "input"), ...Array.from({ length: 60 }, (_, index) => node(`a${index}`, "agent", { prompt: `different ${index}` })), node("output", "output")];
  const edges = nodes.slice(1, -1).flatMap((current, index) => [{ id: `${index}-in`, source: "input", target: current.id }, { id: `${index}-out`, source: current.id, target: "output" }]);
  const graph = { nodes, edges };
  assert.deepEqual(workflowIdentity(graph), workflowIdentity(renamed(graph, "all")));
});

test("disconnected decorations, dangling bindings, duplicate links and cycles are rejected", () => {
  const unused = example(); unused.nodes.push(node("unused", "agent"));
  assert.throws(() => workflowIdentity(unused), /disconnected|non-output/);
  const deadEnd = example(); deadEnd.nodes.push(node("unused", "agent")); deadEnd.edges.push({ id: "dead", source: "input", target: "unused" });
  assert.throws(() => workflowIdentity(deadEnd), /disconnected|non-output/);
  const cyclic = example(); cyclic.edges.push({ id: "back", source: "answer", target: "facts" });
  assert.throws(() => workflowIdentity(cyclic), /cyclic/);
  const dangling = example(); dangling.nodes[2].inputBindings!.text.nodeId = "unknown";
  assert.throws(() => workflowIdentity(dangling), /dangling/);
  const indirect = example(); indirect.nodes[3].inputBindings!.text.nodeId = "input";
  assert.throws(() => workflowIdentity(indirect), /direct predecessor/);
  const repeated = example(); repeated.edges.push({ ...repeated.edges[0], id: "duplicate" });
  assert.throws(() => workflowIdentity(repeated), /duplicate edge/);
  assert.throws(() => groupWorkflowIdentities([{ id: "same", definition: example() }, { id: "same", definition: example() }]), /duplicate/);
});

test("group order and IDs are deterministic regardless of submission order", () => {
  const entries = [{ id: "z", definition: example() }, { id: "a", definition: renamed(example(), "copy") }, { id: "other", definition: chain([node("n", "transform", { transform: { mode: "parse_json" } })]) }];
  const groups = groupWorkflowIdentities(entries);
  assert.deepEqual(groups, groupWorkflowIdentities([...entries].reverse()));
  assert.equal(groups.length, 2); assert.ok(groups.some(group => group.ids.join(",") === "a,z"));
});

test("oversized or recursively embedded graphs fail closed instead of inventing a group", () => {
  const oversized = chain(Array.from({ length: 119 }, (_, index) => node(`n${index}`, "agent")));
  assert.throws(() => workflowIdentity(oversized), /size exceeds/);
  const recursive = chain([node("nested", "subworkflow")]); recursive.nodes[1].subworkflow = { definition: recursive };
  assert.throws(() => workflowIdentity(recursive), /recursive/);
  let tooDeep = example();
  for (let depth = 0; depth < 4; depth++) tooDeep = chain([node("nested", "subworkflow", { subworkflow: { definition: tooDeep } })]);
  assert.throws(() => workflowIdentity(tooDeep), /deeply nested/);
});
