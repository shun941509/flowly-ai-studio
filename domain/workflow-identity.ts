import { isStartNode } from "./advanced-config";
import type { Definition } from "../app/lib/model";

/**
 * Catalog identity, not a claim that two AI programs return the same answers.
 *
 * topology compares directed, typed control graphs (including routes and ordered
 * nested tasks). execution additionally compares bindings and executable settings.
 * Display text, prompts/instructions, document IDs and model names deliberately do
 * not create a new implementation. Document contents, provider capabilities and
 * prompt semantics cannot be established from a Definition and are out of scope.
 *
 * Refinement only partitions candidates; it is NOT the equality decision. We
 * serialize the full graph after bounded individualization, considering all
 * remaining non-interchangeable choices. Exact twins need no permutation search.
 * If that search cannot finish, we reject rather than merge an ambiguous pair.
 * This is intentionally a conservative configuration comparison: different
 * signatures do not prove different useful behavior, and cosmetic rewrites of
 * expressions are not interpreted as algebraically equivalent.
 * Signatures contain literal configuration data; they are not secret-redacting
 * hashes and must not be used for authorization or logged as public telemetry.
 *
 * Pass already migrated/validated definitions. We additionally reject cycles,
 * dangling references, duplicate edges and nodes outside an input-to-output path;
 * unused decoration must not increase the number of implementations.
 */
export type WorkflowIdentity = { topology: string; execution: string };
type Arc = { from: number; to: number; label: string };
type Graph = { labels: string[]; arcs: Arc[] };
type Budget = { nodes: number; states: number; ancestors: Set<Definition> };
const MAX_NODES = 120;
const MAX_DEPTH = 3;
const MAX_SEARCH_STATES = 20_000;

function canonical(value: unknown, depth = 0): string {
  if (depth > 40) throw new Error("Workflow identity: configuration nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(",")}}`;
  throw new Error("Workflow identity: expected a JSON configuration");
}
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function without(value: object, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)));
}

function canonicalGraph(graph: Graph, budget: Budget): string {
  const incoming = graph.labels.map(() => [] as { vertex: number; label: string }[]);
  const outgoing = graph.labels.map(() => [] as { vertex: number; label: string }[]);
  for (const arc of graph.arcs) {
    outgoing[arc.from].push({ vertex: arc.to, label: arc.label });
    incoming[arc.to].push({ vertex: arc.from, label: arc.label });
  }
  const exactNeighbors = graph.labels.map((_, vertex) => canonical([
    incoming[vertex].map(arc => [arc.vertex, arc.label]).sort((a, b) => compare(canonical(a), canonical(b))),
    outgoing[vertex].map(arc => [arc.vertex, arc.label]).sort((a, b) => compare(canonical(a), canonical(b))),
  ]));
  const refine = (partition: number[][]) => {
    for (;;) {
      const colors = new Map(partition.flatMap((cell, color) => cell.map(vertex => [vertex, color] as const)));
      let split = false;
      const next = partition.flatMap(cell => {
        const buckets = new Map<string, number[]>();
        for (const vertex of cell) {
          const signature = canonical([
            incoming[vertex].map(arc => canonical([colors.get(arc.vertex), arc.label])).sort(),
            outgoing[vertex].map(arc => canonical([colors.get(arc.vertex), arc.label])).sort(),
          ]);
          const bucket = buckets.get(signature) ?? []; bucket.push(vertex); buckets.set(signature, bucket);
        }
        if (buckets.size > 1) split = true;
        return [...buckets.entries()].sort(([a], [b]) => compare(a, b)).map(([, vertices]) => vertices);
      });
      if (!split) return next;
      partition = next;
    }
  };
  const serialize = (partition: number[][]) => {
    const order = partition.flat();
    const positions = new Map(order.map((vertex, index) => [vertex, index]));
    return canonical({ nodes: order.map(vertex => graph.labels[vertex]), edges: graph.arcs.map(arc => canonical([positions.get(arc.from), positions.get(arc.to), arc.label])).sort() });
  };
  const search = (partition: number[][]): string => {
    if (++budget.states > MAX_SEARCH_STATES) throw new Error("Workflow identity: symmetric graph exceeds the exact comparison budget; review it separately");
    const refined = refine(partition);
    // Within a cell exact twins have identical labeled neighbors, so exchanging
    // them leaves the complete adjacency serialization unchanged.
    const candidates = refined.map((cell, index) => ({ cell, index })).filter(({ cell }) => cell.length > 1 && cell.some(vertex => exactNeighbors[vertex] !== exactNeighbors[cell[0]]));
    if (!candidates.length) return serialize(refined);
    candidates.sort((a, b) => a.cell.length - b.cell.length || a.index - b.index);
    const { cell, index } = candidates[0];
    const representatives = new Map<string, number>();
    for (const vertex of cell) representatives.set(exactNeighbors[vertex], vertex);
    let best: string | undefined;
    for (const vertex of representatives.values()) {
      const branch = [...refined.slice(0, index), [vertex], cell.filter(item => item !== vertex), ...refined.slice(index + 1)];
      const result = search(branch);
      if (best === undefined || result < best) best = result;
    }
    return best!;
  };
  const labels = new Map<string, number[]>();
  graph.labels.forEach((label, vertex) => { const cell = labels.get(label) ?? []; cell.push(vertex); labels.set(label, cell); });
  return search([...labels.entries()].sort(([a], [b]) => compare(a, b)).map(([, cell]) => cell));
}

function identify(definition: Definition, budget: Budget, depth: number): WorkflowIdentity {
  if (depth > MAX_DEPTH || budget.ancestors.has(definition)) throw new Error("Workflow identity: recursive or too deeply nested definition");
  if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges) || !definition.nodes.length) throw new Error("Workflow identity: empty or malformed graph");
  budget.nodes += definition.nodes.length;
  if (budget.nodes > MAX_NODES || definition.edges.length > 2_000) throw new Error("Workflow identity: graph size exceeds the supported limit");
  budget.ancestors.add(definition);
  try {
    const ids = new Map<string, number>();
    definition.nodes.forEach((node, index) => {
      if (!node.id || ids.has(node.id)) throw new Error("Workflow identity: missing or duplicate node ID");
      ids.set(node.id, index);
    });
    const indexOf = (id: string) => { const index = ids.get(id); if (index === undefined) throw new Error("Workflow identity: dangling node reference"); return index; };
    const control: Arc[] = [];
    const seen = new Set<string>();
    for (const edge of definition.edges) {
      const from = indexOf(edge.source), to = indexOf(edge.target);
      const source = definition.nodes[from];
      // Classification route identifiers are local IDs, unlike literal yes/no
      // and error/success routes. Their declared positions survive ID renaming.
      const labelIndex = source.classification?.labels.findIndex(label => label.id === edge.branch);
      if (source.classification && (labelIndex === undefined || labelIndex < 0)) throw new Error("Workflow identity: unknown classification route");
      const label = canonical(["control", source.classification ? ["class", labelIndex] : edge.branch ?? null]);
      const key = canonical([from, to, label]);
      if (seen.has(key)) throw new Error("Workflow identity: duplicate edge");
      seen.add(key); control.push({ from, to, label });
    }
    const indegree = definition.nodes.map((_, index) => control.filter(arc => arc.to === index).length);
    const queue = indegree.flatMap((degree, index) => degree === 0 ? [index] : []);
    for (let cursor = 0; cursor < queue.length; cursor++) for (const arc of control.filter(arc => arc.from === queue[cursor])) if (--indegree[arc.to] === 0) queue.push(arc.to);
    if (queue.length !== definition.nodes.length) throw new Error("Workflow identity: cyclic control graph");
    const input = definition.nodes.flatMap((node, index) => isStartNode(node) ? [index] : []);
    const output = definition.nodes.flatMap((node, index) => node.type === "output" ? [index] : []);
    if (input.length !== 1 || !output.length) throw new Error("Workflow identity: one start and at least one output are required");
    const reachable = (initial: number[], reverse: boolean) => {
      const found = new Set(initial), pending = [...initial];
      for (let cursor = 0; cursor < pending.length; cursor++) for (const arc of control) {
        if ((reverse ? arc.to : arc.from) !== pending[cursor]) continue;
        const next = reverse ? arc.from : arc.to;
        if (!found.has(next)) { found.add(next); pending.push(next); }
      }
      return found;
    };
    if (reachable(input, false).size !== definition.nodes.length || reachable(output, true).size !== definition.nodes.length) throw new Error("Workflow identity: disconnected or non-output-contributing nodes cannot be counted");
    const executionArcs = [...control];
    const topologyLabels: string[] = [], executionLabels: string[] = [];
    for (const [index, node] of definition.nodes.entries()) {
      const topology: Record<string, unknown> = { type: node.type };
      const execution = without(node, ["id", "title", "description", "x", "y", "prompt", "resourceId", "model", "modelName", "embeddingModel", "inputBindings", "parallel", "team", "orchestration", "subworkflow", "loop", "compensation"]);
      for (const [port, binding] of Object.entries(node.inputBindings ?? {})) {
        const from = indexOf(binding.nodeId);
        if (!control.some(arc => arc.from === from && arc.to === index)) throw new Error("Workflow identity: binding is not a direct predecessor");
        executionArcs.push({ from, to: index, label: canonical(["binding", port, binding.path]) });
      }
      if (node.compensation) {
        executionArcs.push({ from: indexOf(node.compensation.sourceNodeId), to: index, label: "compensation-source" });
        execution.compensation = without(node.compensation, ["sourceNodeId"]);
      }
      if (node.review) execution.review = without(node.review, ["instructions"]);
      if (node.evaluation) execution.evaluation = without(node.evaluation, ["rubric"]);
      if (node.form) execution.form = { ...(node.form.mode === "request" ? { mode: "request", timeoutMinutes: node.form.timeoutMinutes ?? 1440 } : {}), fields: node.form.fields.map(field => without(field, ["label"])) };
      if (node.classification) execution.classification = { labels: node.classification.labels.map(() => ({})) };
      if (node.retrieval) execution.retrieval = { ...without(node.retrieval, ["resourceIds"]), resourceCount: new Set(node.retrieval.resourceIds).size };
      if (node.knowledge) execution.knowledge = { ...without(node.knowledge, ["resourceIds", "evaluation"]), resourceCount: new Set(node.knowledge.resourceIds).size, evaluationCount: node.knowledge.evaluation?.length ?? 0 };
      if (node.allowedTools) execution.allowedTools = node.allowedTools.map(tool => without(tool, ["resourceId", "connectionId"])).map(tool => canonical(tool)).sort();
      for (const field of ["parallel", "team", "orchestration"] as const) {
        const config = node[field]; if (!config) continue;
        if (new Set(config.tasks.map(task => task.id)).size !== config.tasks.length) throw new Error("Workflow identity: duplicate nested task ID");
        const children = config.tasks.map(task => identify(task.definition, budget, depth + 1));
        // Task array order is deliberately retained: sequential roles and result
        // positions are observable even when execution is parallel.
        topology[field] = children.map(child => child.topology);
        execution[field] = { ...without(config, ["tasks"]), tasks: children.map(child => child.execution), ...(config.tasks.some(task => task.dependsOn?.length) ? { dependencies: config.tasks.map(task => (task.dependsOn ?? []).map(id => config.tasks.findIndex(candidate => candidate.id === id)).sort((a,b) => a-b)) } : {}) };
      }
      for (const field of ["subworkflow", "loop"] as const) {
        const config = node[field]; if (!config) continue;
        const child = identify(config.definition, budget, depth + 1);
        topology[field] = child.topology;
        execution[field] = { ...without(config, ["definition"]), definition: child.execution };
      }
      topologyLabels.push(canonical(topology)); executionLabels.push(canonical(execution));
    }
    return { topology: `flowly-topology-v1:${canonicalGraph({ labels: topologyLabels, arcs: control }, budget)}`, execution: `flowly-execution-v1:${canonicalGraph({ labels: executionLabels, arcs: executionArcs }, budget)}` };
  } finally { budget.ancestors.delete(definition); }
}

export function workflowIdentity(definition: Definition): WorkflowIdentity {
  return identify(definition, { nodes: 0, states: 0, ancestors: new Set() }, 0);
}

/** Includes singleton groups; entry IDs are labels only and must be unique. */
export function groupWorkflowIdentities(entries: { id: string; definition: Definition }[]): { topology: string; execution: string; ids: string[] }[] {
  const ids = new Set<string>();
  const groups = new Map<string, { topology: string; execution: string; ids: string[] }>();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error("Workflow identity: duplicate or empty entry ID");
    ids.add(entry.id);
    const identity = workflowIdentity(entry.definition), key = canonical([identity.topology, identity.execution]);
    const group = groups.get(key) ?? { ...identity, ids: [] }; group.ids.push(entry.id); groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, ids: group.ids.sort(compare) })).sort((a, b) => compare(a.topology, b.topology) || compare(a.execution, b.execution));
}
