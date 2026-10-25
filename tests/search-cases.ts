import type { Json } from "../runtime/types";
import { parseSearchConfig } from "../domain/search-config";
export const treeProblem = { items: [{ id: "a", value: 6 }, { id: "b", value: 4 }, { id: "c", value: 3 }], target: 7 };
export const graphProblem = { items: [{ id: "a", value: 2 }, { id: "b", value: 3 }, { id: "c", value: 4 }, { id: "d", value: 1 }], target: 8 };
export const create = (items: string[], parents?: string[]) => ({ type: "create", items, ...(parents ? { parents } : {}) });
export const treeReplies: Record<string, Json>[] = [{ actions: [create(["a"]), create(["b"])] }, { actions: [] }, { actions: [create(["b", "c"])] }];
export const graphReplies: Record<string, Json>[] = [
  { actions: [create(["a"]), create(["b"]), create(["c"])] },
  { actions: [create(["a", "b"], ["c1", "c2"]), create(["a", "b", "d"], ["c4"])] },
  { actions: [{ type: "revise", id: "c1", items: ["d"] }, create(["b", "d"], ["c1", "c2"])] },
  { actions: [create(["b", "c", "d"], ["c6", "c3"])] },
];
export const searchCases = [
  { name: "tree backtracks from a dead end before finding a verified sum", config: parseSearchConfig({ mode: "tree" }), input: treeProblem, replies: treeReplies, solved: true },
  { name: "graph invalidates descendants after a revised ancestor then merges new versions", config: parseSearchConfig({ mode: "graph" }), input: graphProblem, replies: graphReplies, solved: true },
  { name: "iteration limit reports no solution", config: parseSearchConfig({ mode: "tree", maxIterations: 2 }), input: treeProblem, replies: treeReplies.slice(0, 2), solved: false },
  { name: "frontier beam prunes lowest ranked candidates", config: parseSearchConfig({ mode: "tree", beamWidth: 2 }), input: treeProblem, replies: [{ actions: [create(["a"]), create(["b"]), create(["c"])] }, { actions: [] }, { actions: [create(["b", "c"])] }], solved: true },
  { name: "empty frontier reports exhaustion", config: parseSearchConfig({ mode: "tree" }), input: treeProblem, replies: [{ actions: [] }], solved: false },
  { name: "tree numerically rejects an overshoot and backtracks to a viable sibling", config: parseSearchConfig({ mode: "tree" }), input: treeProblem, replies: [treeReplies[0], { actions: [create(["a", "b"])] }, treeReplies[2]], solved: true },
];
