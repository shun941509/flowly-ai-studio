/**
 * DAG의 단계와 가지를 캔버스 좌표로 배치하고 연결선을 우회시킨다.
 * 배치 순서는 화면 표현이며 실제 실행 가능 여부와 입력 매핑은 그래프 검증·실행기가 결정한다.
 */
import type { Definition, FlowEdge, FlowNode } from "../app/lib/model";
import { nodeRoutes } from "./advanced-config";

export const WORKFLOW_NODE_WIDTH = 238;
export const WORKFLOW_NODE_HEIGHT = 112;
const COLUMN = 338, ROW = 210, MARGIN = 40, CLEARANCE = 18;
export type GraphPoint = { x: number; y: number };
export type GraphBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
export type EdgeRoute = { edgeId: string; points: GraphPoint[]; path: string; label: GraphPoint; blocked: boolean };

/** Presentation only: retain node/edge array order, IDs, bindings and policies. */
/**
 * 선행 관계를 기준으로 좌표를 계산한다. 노드의 업무 설정이나 연결 의미를 바꾸지 않는다.
 */
export function layoutWorkflow(definition: Definition, options: { recursive?: boolean } = {}): Definition {
  const nodes = definition.nodes;
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const incoming = new Map(nodes.map(node => [node.id, definition.edges.filter(edge => edge.target === node.id && indices.has(edge.source))]));
  const pending = new Map(nodes.map(node => [node.id, incoming.get(node.id)!.length]));
  const depths = new Map<string, number>();
  const queue = nodes.filter(node => !pending.get(node.id)).map(node => node.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    depths.set(id, Math.max(0, ...incoming.get(id)!.map(edge => (depths.get(edge.source) ?? -1) + 1)));
    for (const edge of definition.edges.filter(edge => edge.source === id && pending.has(edge.target))) {
      pending.set(edge.target, pending.get(edge.target)! - 1);
      if (pending.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  // Invalid cyclic imports remain editable; arranging never changes their graph.
  let fallback = Math.max(-1, ...depths.values()) + 1;
  for (const node of nodes) if (!depths.has(node.id)) depths.set(node.id, fallback++);
  const levels = new Map<number, FlowNode[]>();
  for (const node of nodes) { const depth = depths.get(node.id)!; levels.set(depth, [...(levels.get(depth) ?? []), node]); }
  const positions = new Map<string, number>();
  for (const [, level] of [...levels].sort(([a], [b]) => a - b)) {
    const barycenter = (node: FlowNode) => { const parents = incoming.get(node.id)!.map(edge => positions.get(edge.source)).filter((value): value is number => value !== undefined); return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : indices.get(node.id)!; };
    level.sort((a, b) => barycenter(a) - barycenter(b) || indices.get(a.id)! - indices.get(b.id)!);
    level.forEach((node, lane) => positions.set(node.id, lane - (level.length - 1) / 2));
  }
  const columns = Math.max(1, ...[...levels.values()].map(level => level.length));
  const step = Math.min(COLUMN, (9800 - WORKFLOW_NODE_WIDTH) / Math.max(1, columns - 1));
  const center = MARGIN + (columns - 1) * step / 2;
  return { ...definition, nodes: nodes.map(node => {
    const result = { ...node, x: Math.round(center + positions.get(node.id)! * step), y: MARGIN + depths.get(node.id)! * ROW };
    if (options.recursive !== false) {
      if (node.parallel) result.parallel = { ...node.parallel, tasks: node.parallel.tasks.map(task => ({ ...task, definition: layoutWorkflow(task.definition, options) })) };
      if (node.team) result.team = { ...node.team, tasks: node.team.tasks.map(task => ({ ...task, definition: layoutWorkflow(task.definition, options) })) };
      if (node.orchestration) result.orchestration = { ...node.orchestration, tasks: node.orchestration.tasks.map(task => ({ ...task, definition: layoutWorkflow(task.definition, options) })) };
      if (node.loop) result.loop = { ...node.loop, definition: layoutWorkflow(node.loop.definition, options) };
      if (node.subworkflow) result.subworkflow = { ...node.subworkflow, definition: layoutWorkflow(node.subworkflow.definition, options) };
    }
    return result;
  }) };
}

export function executionModeLabel(node: FlowNode): string | undefined {
  if (node.parallel) return `${node.parallel.tasks.length}개 작업 · 동시 최대 ${node.parallel.concurrency}개`;
  if (node.team) return node.team.mode === "sequential" ? `${node.team.tasks.length}개 역할 · 앞 결과를 전달하며 순차 실행` : `${node.team.tasks.length}개 역할 · 동시 최대 ${node.team.concurrency}개`;
  if (node.orchestration) return node.orchestration.mode === "dynamic" ? `동적 생성 · 최대 ${node.orchestration.dynamic?.maxAgents ?? 0}개 · 동시 ${node.orchestration.dynamic?.concurrency ?? 1}개` : node.orchestration.mode === "adaptive" ? `결과 확인 후 다음 작업 선택 · 최대 ${node.orchestration.maxRounds ?? 8}회` : `AI가 작업·순서 선택 · 최대 ${node.orchestration.maxTasks}개`;
  if (node.loop) return `항목별 반복 · 최대 ${node.loop.maxItems}개 · 동시 ${node.loop.concurrency}개`;
  if (node.subworkflow) return "하위 워크플로 실행 · 완료 결과 전달";
}

export function edgePorts(source: FlowNode, target: FlowNode, edge: FlowEdge): { start: GraphPoint; end: GraphPoint } {
  const branches = nodeRoutes(source), index = branches.findIndex(branch => branch.id === edge.branch);
  return { start: { x: source.x + (index < 0 ? WORKFLOW_NODE_WIDTH / 2 : WORKFLOW_NODE_WIDTH * (index + 1) / (branches.length + 1)), y: source.y + WORKFLOW_NODE_HEIGHT }, end: { x: target.x + WORKFLOW_NODE_WIDTH / 2, y: target.y } };
}

/** Axis-aligned segment vs node interior; touching a port/border is permitted. */
export function segmentCrossesNode(a: GraphPoint, b: GraphPoint, node: FlowNode): boolean {
  const right = node.x + WORKFLOW_NODE_WIDTH, bottom = node.y + WORKFLOW_NODE_HEIGHT;
  if (a.x === b.x) return a.x > node.x && a.x < right && Math.max(a.y, b.y) > node.y && Math.min(a.y, b.y) < bottom;
  if (a.y === b.y) return a.y > node.y && a.y < bottom && Math.max(a.x, b.x) > node.x && Math.min(a.x, b.x) < right;
  return true;
}
const distance = (a: GraphPoint, b: GraphPoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
function simplify(points: GraphPoint[]): GraphPoint[] {
  const result: GraphPoint[] = [];
  for (const point of points) {
    if (result.length && distance(result.at(-1)!, point) === 0) continue;
    while (result.length >= 2) {
      const a = result.at(-2)!, b = result.at(-1)!;
      if (!((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

/** Visibility-grid fallback for manually positioned, non-overlapping nodes. */
function gridRoute(start: GraphPoint, end: GraphPoint, nodes: FlowNode[]): GraphPoint[] | null {
  const xs = [...new Set([start.x, end.x, ...nodes.flatMap(node => [node.x - CLEARANCE, node.x + WORKFLOW_NODE_WIDTH + CLEARANCE])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...nodes.flatMap(node => [node.y - CLEARANCE, node.y + WORKFLOW_NODE_HEIGHT + CLEARANCE])])].sort((a, b) => a - b);
  const width = xs.length, point = (index: number) => ({ x: xs[index % width], y: ys[Math.floor(index / width)] });
  const source = ys.indexOf(start.y) * width + xs.indexOf(start.x), target = ys.indexOf(end.y) * width + xs.indexOf(end.x);
  const cost = new Map<number, number>([[source, 0]]), previous = new Map<number, number>();
  const open = new Set([source]);
  while (open.size) {
    let current = -1, best = Infinity;
    for (const candidate of open) { const score = cost.get(candidate)! + distance(point(candidate), end); if (score < best) { best = score; current = candidate; } }
    if (current === target) { const path = [point(target)]; while (previous.has(current)) { current = previous.get(current)!; path.unshift(point(current)); } return path; }
    open.delete(current);
    const x = current % width, y = Math.floor(current / width);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || nx >= xs.length || ny < 0 || ny >= ys.length) continue;
      const next = ny * width + nx, a = point(current), b = point(next);
      if (nodes.some(node => segmentCrossesNode(a, b, node))) continue;
      const nextCost = cost.get(current)! + distance(a, b);
      if (nextCost < (cost.get(next) ?? Infinity)) { cost.set(next, nextCost); previous.set(next, current); open.add(next); }
    }
  }
  return null;
}

/**
 * 노드 영역과 분기 포트를 고려해 화면에 그릴 연결선 경로를 계산한다.
 */
export function routeWorkflowEdges(definition: Definition): EdgeRoute[] {
  const lookup = new Map(definition.nodes.map(node => [node.id, node]));
  const clear = (points: GraphPoint[]) => points.every((point, index) => !index || !definition.nodes.some(node => segmentCrossesNode(points[index - 1], point, node)));
  return definition.edges.flatMap((edge, index) => {
    const source = lookup.get(edge.source), target = lookup.get(edge.target);
    if (!source || !target) return [];
    const { start, end } = edgePorts(source, target, edge);
    const gap = CLEARANCE + (index % 4) * 6;
    const exit = { x: start.x, y: start.y + gap }, entry = { x: end.x, y: end.y - gap };
    const middle = (start.y + end.y) / 2;
    const candidates = [
      [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end],
      ...[start.x, end.x, ...definition.nodes.flatMap(node => [node.x - gap, node.x + WORKFLOW_NODE_WIDTH + gap])].map(x => [start, exit, { x, y: exit.y }, { x, y: entry.y }, entry, end]),
    ].filter(clear);
    candidates.sort((a, b) => a.reduce((sum, p, i) => sum + (i ? distance(a[i - 1], p) : 0), 0) - b.reduce((sum, p, i) => sum + (i ? distance(b[i - 1], p) : 0), 0));
    const found = candidates[0] ?? (clear([start, exit]) && clear([entry, end]) ? gridRoute(exit, entry, definition.nodes)?.map(point => point) : null);
    const raw = candidates[0] ?? (found ? [start, ...found, end] : [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end]);
    const points = simplify(raw);
    const segments = points.slice(1).map((point, i) => ({ a: points[i], b: point }));
    const labelSegment = segments.filter(({ a, b }) => a.y === b.y && distance(a, b) >= 36).sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b))[0] ?? segments.sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b))[0];
    return [{ edgeId: edge.id, points, path: points.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" "), label: labelSegment ? { x: (labelSegment.a.x + labelSegment.b.x) / 2, y: (labelSegment.a.y + labelSegment.b.y) / 2 } : start, blocked: !clear(points) }];
  });
}

/**
 * 노드 크기를 포함한 전체 경계를 구해 화면 맞춤과 이동 범위 계산에 사용한다.
 */
export function workflowBounds(definition: Definition, routes = routeWorkflowEdges(definition)): GraphBounds {
  const points = [...definition.nodes.flatMap(node => [{ x: node.x, y: node.y }, { x: node.x + WORKFLOW_NODE_WIDTH, y: node.y + WORKFLOW_NODE_HEIGHT }]), ...routes.flatMap(route => route.points)];
  if (!points.length) points.push({ x: 0, y: 0 }, { x: WORKFLOW_NODE_WIDTH, y: WORKFLOW_NODE_HEIGHT });
  const minX = Math.min(...points.map(point => point.x)) - 30, minY = Math.min(...points.map(point => point.y)) - 30;
  const maxX = Math.max(...points.map(point => point.x)) + 30, maxY = Math.max(...points.map(point => point.y)) + 30;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Find a nearby empty slot without moving any existing user node. */
/**
 * 기존 노드와의 겹침을 줄이는 새 블록 위치를 찾는다.
 */
export function placeNewNode(definition: Definition, preferred?: GraphPoint): GraphPoint {
  const anchor = preferred ?? { x: MARGIN, y: definition.nodes.length ? Math.max(...definition.nodes.map(node => node.y)) + ROW : MARGIN };
  const free = (point: GraphPoint) => point.x >= -9800 && point.x <= 9800 && point.y >= -9800 && point.y <= 9800 && definition.nodes.every(node => point.x + WORKFLOW_NODE_WIDTH + 24 <= node.x || node.x + WORKFLOW_NODE_WIDTH + 24 <= point.x || point.y + WORKFLOW_NODE_HEIGHT + 24 <= node.y || node.y + WORKFLOW_NODE_HEIGHT + 24 <= point.y);
  const base = { x: Math.max(-9800, Math.min(9800, anchor.x)), y: Math.max(-9800, Math.min(9800, anchor.y)) };
  if (free(base)) return base;
  for (let radius = 1; radius <= 40; radius++) {
    const offsets = [0, ...Array.from({ length: radius }, (_, index) => [index + 1, -index - 1]).flat()];
    for (const row of offsets) for (const column of offsets) {
      if (Math.abs(row) !== radius && Math.abs(column) !== radius) continue;
      const point = { x: base.x + column * COLUMN, y: base.y + row * ROW };
      if (free(point)) return point;
    }
  }
  return base;
}
